import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const scripts = ['deploy.sh', ...readdirSync('deploy').filter(name => name.endsWith('.sh')).map(name => 'deploy/' + name)];

test('deploy scripts parse, use pipefail and an ERR trap', () => {
  for (const file of scripts) {
    execFileSync('bash', ['-n', file]);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^set -E[a-z]*uo pipefail$/m, file + ' sets -E -u -o pipefail');
    assert.match(text, /^trap '.*\$LINENO.*' ERR$/m, file + ' prints the failing line on error');
  }
});

test('no early-exit filter reads from a pipe (SIGPIPE plus pipefail would kill the script silently)', () => {
  const risky = /(?<!\|)\|(?!\|)\s*(?:awk\b[^|]*\bexit\b|head\b|grep\s+-[a-zA-Z]*q|sed\s+-n\s+'?\d+q)/;
  for (const file of scripts) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      assert.ok(!risky.test(line), file + ':' + (index + 1) + ' pipes into an early-exit filter: ' + line.trim());
    });
  }
});

test('the ERR trap names the line instead of dying silently', () => {
  const script = [
    'set -Eeuo pipefail',
    "trap 'rc=$?; echo \"ERROR: line $LINENO: $BASH_COMMAND (exit $rc)\" >&2' ERR",
    'value=$(seq 1 200000 | awk \'{print; exit}\')',
    'echo "not reached $value"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'pipefail catches the SIGPIPE from the early awk exit');
  assert.match(result.stderr, /ERROR: line 3: .*exit 141/);
  assert.ok(!result.stdout.includes('not reached'));
});

test('the here-string form used in setup-ipv6-net.sh survives an early awk exit', () => {
  const sample = '● 2: ens4\n     Link File: /usr/lib/systemd/network/99-default.link\n  Network File: /run/systemd/network/10-netplan-ens4.network\n        State: routable (configured)\n';
  const script = [
    'set -Eeuo pipefail',
    "trap 'echo \"ERROR line $LINENO\" >&2' ERR",
    'status=$(cat)',
    'NETFILE=$(awk -F\': \' \'/Network File/ {print $2; exit}\' <<<"$status")',
    'echo "${NETFILE##*/}"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { input: sample, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '10-netplan-ens4.network');
});

test('setup-ipv6-net.sh put() writes once, then reports unchanged on a rerun', () => {
  const text = readFileSync('deploy/setup-ipv6-net.sh', 'utf8');
  const fn = text.slice(text.indexOf('changed=0'), text.indexOf('drop() {'));
  const script = [
    'set -Eeuo pipefail',
    'sudo() { "$@"; }',
    fn,
    'dir=$(mktemp -d)',
    "put \"$dir/zz.conf\" <<'C'\n[Resolve]\nDNS=\nDNS=x\nC",
    'echo "changed=$changed"; changed=0',
    "put \"$dir/zz.conf\" <<'C'\n[Resolve]\nDNS=\nDNS=x\nC",
    'echo "changed=$changed"',
    'rm -rf "$dir"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote: .*zz\.conf\nchanged=1\nunchanged: .*zz\.conf\nchanged=0/);
});

test('health timer DNS check reads the Global current server and spots a non nat64.net server', () => {
  const text = readFileSync('deploy/healthcheck-ping.sh', 'utf8');
  const awk = /current=\$\(awk '([^']+)'/.exec(text)[1];
  const sample = server => 'Global\n           Protocols: +LLMNR\n  resolv.conf mode: stub\nCurrent DNS Server: ' + server + '\n         DNS Servers: 2a01:4f9:c010:3f02::1\n\nLink 2 (ens4)\nCurrent DNS Server: 169.254.169.254\n';
  for (const [server, expected] of [['2a00:1098:2c::1', 'nat64'], ['2606:4700:4700::1111', 'other'], ['169.254.169.254', 'other']]) {
    const script = `NAT64_DNS="2a01:4f9:c010:3f02::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1"; current=$(awk '${awk}' <<<"$(cat)"); if [ -n "$current" ] && [[ " $NAT64_DNS " != *" $current "* ]]; then echo other; else echo nat64; fi`;
    const result = spawnSync('bash', ['-c', script], { input: sample(server), encoding: 'utf8' });
    assert.equal(result.stdout.trim(), expected, server);
  }
});

// Real Ubuntu 24.04 (systemd 255) output. resolvectl status has no "Default Route:" line, only "Protocols: -DefaultRoute".
const ubuntuStatus = readFileSync('test/fixtures/resolvectl-ubuntu-24.04.txt', 'utf8');
const defaultRouteOff = 'Link 2 (ens4): no\n';
const defaultRouteOn = 'Link 2 (ens4): yes\n';

test('default route checks use resolvectl default-route, not status text that Ubuntu 24.04 does not print', () => {
  assert.ok(!ubuntuStatus.includes('Default Route:'), 'fixture matches real 24.04 output');
  assert.match(ubuntuStatus, /Protocols: -DefaultRoute/);
  for (const file of ['deploy/setup-ipv6-net.sh', 'deploy/verify.sh']) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/grep[^\n]*'Default Route: no'/.test(text), file + ' must not grep the status text for "Default Route: no"');
    assert.match(text, /resolvectl default-route /, file + ' uses resolvectl default-route');
    assert.match(text, /grep -q ': no\$'/, file + " matches ': no$'");
  }
  const check = out => spawnSync('bash', ['-c', "out=$(cat); grep -q ': no$' <<<\"$out\""], { input: out }).status === 0;
  assert.equal(check(defaultRouteOff), true, 'ens4 off reads as not default route');
  assert.equal(check(defaultRouteOn), false, 'ens4 on reads as default route');
  assert.equal(check(ubuntuStatus), false, 'status text alone never passes, so the old check could not be fixed by grepping it');
});

test('setup-ipv6-net.sh not_default_route() passes on real output and reapplies the link when it fails', () => {
  const text = readFileSync('deploy/setup-ipv6-net.sh', 'utf8');
  const fns = text.slice(text.indexOf('apply_link() {'), text.indexOf('if [ "$changed" = 1 ]; then'));
  assert.match(text, /networkctl reload/);
  assert.match(text, /networkctl reconfigure "\$IFACE"/);
  for (const [answers, expected] of [[[defaultRouteOff], 'ok first'], [[defaultRouteOn, defaultRouteOff], 'ok after reapply'], [[defaultRouteOn, defaultRouteOn], 'still default']]) {
    const script = [
      'set -Eeuo pipefail',
      'IFACE=ens4; answers=("$@"); counter=$(mktemp); echo 0 > "$counter"',
      // resolvectl runs inside $( ), a subshell, so the call count lives in a file.
      'resolvectl() { local n; n=$(cat "$counter"); echo $((n + 1)) > "$counter"; printf "%s" "${answers[$n]}"; }',
      'sudo() { echo "sudo $*" >&2; }',
      'sleep() { :; }',
      fns,
      'if not_default_route; then echo "ok first"; else apply_link; if not_default_route; then echo "ok after reapply"; else echo "still default"; fi; fi',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script, 'test', ...answers], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(expected));
    if (expected !== 'ok first') assert.match(result.stderr, /sudo networkctl reload[\s\S]*sudo networkctl reconfigure ens4/);
  }
});

test('health timer reads the Global current DNS server from real Ubuntu 24.04 output', () => {
  const awk = /current=\$\(awk '([^']+)'/.exec(readFileSync('deploy/healthcheck-ping.sh', 'utf8'))[1];
  const result = spawnSync('bash', ['-c', `awk '${awk}' <<<"$(cat)"`], { input: ubuntuStatus, encoding: 'utf8' });
  assert.equal(result.stdout.trim(), '2a01:4f9:c010:3f02::1', 'Global server, not the ens4 link server');
});

test('verify.sh parses real VM output from the first run (systemd 255 query format, missing Docker)', () => {
  const text = readFileSync('deploy/verify.sh', 'utf8');
  // Real line from the VM: resolvectl query prints "name IN AAAA address -- link: ens4", with no colon after the name.
  const restored = 'github.com IN AAAA 2a01:4f9:c010:3f02:64:0:8c52:7903        -- link: ens4';
  const pattern = /\[\[ "\$out" =~ (\^github\S+) \]\]/.exec(text)[1];
  const match = line => spawnSync('bash', ['-c', `out=$(cat); [[ "$out" =~ ${pattern} ]]`], { input: line }).status === 0;
  assert.equal(match(restored), true, 'restored github.com line passes');
  assert.equal(match('github.com: resolve call failed: timeout'), false);
  // supabase.com publishes no AAAA record ("does not have any RR of the requested type"), so it cannot be a failover probe.
  const probes = /for name in ([^;]+); do/.exec(text)[1].split(/\s+/);
  assert.ok(!probes.includes('supabase.com'));
  assert.equal(probes.length, 3);
  // Memory parsing: real docker stats value parses, and no Docker gives a clean FAIL instead of a Python traceback.
  const block = text.slice(text.indexOf('used=""; limit=""'), text.indexOf('echo "a2z-mcp uses'));
  for (const [usage, expected] of [['143.2MiB / 512MiB', '143 512'], ['', ' ']]) {
    const result = spawnSync('bash', ['-c', `usage='${usage}'\n${block}\necho "$used $limit"`], { encoding: 'utf8' });
    assert.equal(result.stderr, '', 'no traceback for ' + JSON.stringify(usage));
    assert.equal(result.stdout.trim(), expected.trim());
  }
});
