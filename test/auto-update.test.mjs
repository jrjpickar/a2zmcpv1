import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('deploy/auto-update.sh');
const sha1 = 'a'.repeat(40), sha2 = 'b'.repeat(40);

// Fake curl and docker. Behavior comes from env: FAKE_SHA, FAKE_TGZ, FAKE_HEALTH (ok|fail), FAKE_DOWNLOAD (ok|fail).
const curl = `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done
case "$url" in
  https://a2zmcp.netlify.app/version.json*) printf '{"commit":"%s","deployId":"dep1"}' "$FAKE_SHA";;
  https://api.github.com/repos/*/tarball/*) [ "$FAKE_DOWNLOAD" = ok ] || exit 22; cp "$FAKE_TGZ" "$out";;
  http://127.0.0.1:8080/health) [ "$FAKE_HEALTH" = ok ];;
  *) exit 0;;
esac
`;
const docker = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "image inspect") case "$*" in *candidate*) echo sha256:new;; *) echo sha256:old;; esac;;
  "inspect -f") echo sha256:new;;
esac
exit 0
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'a2z-au-'));
  const bin = join(root, 'bin'), repo = join(root, 'repo');
  mkdirSync(bin); mkdirSync(join(repo, 'server'), { recursive: true }); mkdirSync(join(repo, 'netlify'), { recursive: true });
  writeFileSync(join(bin, 'curl'), curl); writeFileSync(join(bin, 'docker'), docker);
  chmodSync(join(bin, 'curl'), 0o755); chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(repo, '.env'), 'SECRET=keep\n');
  writeFileSync(join(repo, '.autoupdate.env'), 'NETLIFY_SITE_URL=https://a2zmcp.netlify.app\nGITHUB_REPO=jesse/a2zmcpv1\nGITHUB_TOKEN=g\n');
  writeFileSync(join(repo, 'server/index.mjs'), 'old');
  writeFileSync(join(repo, 'netlify/gone.mjs'), 'old only');
  writeFileSync(join(repo, 'notes.txt'), 'never shipped');
  const tarball = (name, files) => {
    const src = join(root, name, 'jesse-a2zmcpv1-x');
    for (const [file, text] of Object.entries(files)) { mkdirSync(join(src, file, '..'), { recursive: true }); writeFileSync(join(src, file), text); }
    execFileSync('tar', ['czf', join(root, name + '.tgz'), '-C', join(root, name), 'jesse-a2zmcpv1-x']);
    return join(root, name + '.tgz');
  };
  const base = { Dockerfile: 'FROM x', 'docker-compose.yml': 'services: {}', 'server/index.mjs': 'new' };
  const tgz1 = tarball('one', { ...base, 'netlify/gone.mjs': 'v1', 'netlify/keep.mjs': 'v1', '.env': 'SECRET=from-repo' });
  const tgz2 = tarball('two', { ...base, 'server/index.mjs': 'v2', 'netlify/keep.mjs': 'v2' });
  const log = join(root, 'docker.log');
  const run = env => spawnSync('bash', [script], { encoding: 'utf8', env: {
    PATH: bin + ':' + process.env.PATH, A2Z_REPO: repo, A2Z_HEALTH_TRIES: '2', A2Z_HEALTH_SLEEP: '0', A2Z_INSTALL_PATH: '',
    FAKE_LOG: log, FAKE_DOWNLOAD: 'ok', FAKE_HEALTH: 'ok', ...env } });
  const read = file => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf8') : null);
  const dockerLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { run, read, dockerLog, tgz1, tgz2 };
}

test('follows the published commit, keeps .env and unshipped files, and skips an unchanged commit', () => {
  const t = setup();
  const first = t.run({ FAKE_SHA: sha1, FAKE_TGZ: t.tgz1 });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /Healthy on aaaaaaa/);
  assert.equal(t.read('.deploy-state/deployed').trim(), sha1);
  assert.equal(t.read('server/index.mjs'), 'new');
  assert.equal(t.read('.env'), 'SECRET=keep\n');
  assert.equal(t.read('notes.txt'), 'never shipped');
  assert.match(t.dockerLog(), /build --pull -t a2z-mcp:candidate/);
  assert.match(t.dockerLog(), /image tag a2z-mcp:latest a2z-mcp:previous/);
  const builds = t.dockerLog().split('build --pull').length;
  assert.equal(t.run({ FAKE_SHA: sha1, FAKE_TGZ: t.tgz1 }).status, 0);
  assert.equal(t.dockerLog().split('build --pull').length, builds, 'no rebuild for the same commit');
});

test('an unhealthy update is rolled back, recorded as failed and not retried', () => {
  const t = setup();
  assert.equal(t.run({ FAKE_SHA: sha1, FAKE_TGZ: t.tgz1 }).status, 0);
  const bad = t.run({ FAKE_SHA: sha2, FAKE_TGZ: t.tgz2, FAKE_HEALTH: 'fail' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /Restoring aaaaaaa/);
  assert.equal(t.read('server/index.mjs'), 'new');
  assert.equal(t.read('netlify/gone.mjs'), 'v1');
  assert.equal(t.read('.deploy-state/deployed').trim(), sha1);
  assert.equal(t.read('.deploy-state/failed').trim(), sha2);
  assert.match(t.dockerLog(), /image tag a2z-mcp:previous a2z-mcp:latest/);
  const again = t.run({ FAKE_SHA: sha2, FAKE_TGZ: t.tgz2 });
  assert.match(again.stdout, /failed before/);
});

test('a healthy update removes files that left the repo', () => {
  const t = setup();
  t.run({ FAKE_SHA: sha1, FAKE_TGZ: t.tgz1 });
  const ok = t.run({ FAKE_SHA: sha2, FAKE_TGZ: t.tgz2 });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(t.read('netlify/gone.mjs'), null);
  assert.equal(t.read('netlify/keep.mjs'), 'v2');
  assert.equal(t.read('notes.txt'), 'never shipped');
});

test('a download error changes nothing and is retried next run', () => {
  const t = setup();
  const r = t.run({ FAKE_SHA: sha1, FAKE_TGZ: t.tgz1, FAKE_DOWNLOAD: 'fail' });
  assert.notEqual(r.status, 0);
  assert.equal(t.read('.deploy-state/failed'), null);
  assert.equal(t.read('server/index.mjs'), 'old');
  assert.doesNotMatch(t.dockerLog(), /build/);
});

test('a manual Netlify deploy with no commit is ignored', () => {
  const t = setup();
  const r = t.run({ FAKE_SHA: '' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /has no commit/);
});

test('the timer runs at 11 AM and 3 PM Pacific only and catches up after downtime', () => {
  const timer = readFileSync('deploy/systemd/a2z-auto-update.timer', 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 11,15:00:00 America\/Los_Angeles$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.doesNotMatch(timer, /OnUnitInactiveSec|OnUnitActiveSec|OnBootSec/);
});
