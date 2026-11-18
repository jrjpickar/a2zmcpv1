import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecuteHandler } from '../netlify/functions/jarvis-execute.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { runPlan, sandboxTables, validatePlan } from '../netlify/functions/lib/jarvis-sandbox.mjs';
import { supabaseStore } from '../netlify/functions/lib/jarvis-store.mjs';
import { fetchMailbox, mailboxContext, MAIL_KEY } from '../netlify/functions/lib/jarvis-mail.mjs';
import { report } from '../netlify/functions/lib/report.mjs';
import { env, get, plan, post } from './jarvis-helpers.mjs';

const sample = await report({ preset: 'mtd' }, { DATA_MODE: 'sample' });
const handler = (store = memoryAdapter(), extra = {}) => createExecuteHandler({ env: { ...env, ...extra.env }, openStore: async () => store, readReport: async () => sample, ...extra.options });
const send = async (run, body, headers) => {
  const response = await run(post('/api/jarvis-execute', body, headers));
  return { status: response.status, data: await response.json() };
};

// The plan the LCP bot produced. A2Z has no opportunities table, so it validates but fails safely in the sandbox.
const lcpPlan = {
  task: 'Update Leads Module to Use Opportunity Count per City',
  steps: [
    { action: 'Create View', sql: 'CREATE OR REPLACE VIEW opps_by_city AS SELECT city, COUNT(*) AS opp_count FROM opportunities GROUP BY city;' },
    { action: 'Update Module', module: 'Leads', field: 'opportunities', source: 'opps_by_city', fieldName: 'opp_count' },
    { action: 'Schedule Refresh', schedule: '0 2 * * *', description: 'Nightly refresh of opps_by_city view' },
    { action: 'Trigger Immediate Update', module: 'Leads', description: 'Refresh module data now' },
  ],
  validation: [{ check: 'Verify Module Data', query: 'SELECT city, opp_count FROM opps_by_city LIMIT 10;' }],
  report: { range: { from: '2026-10-20', to: '2026-11-18' }, current: { dials: 10028 } },
};

test('static validation blocks unsafe SQL and unknown actions', () => {
  const one = sql => validatePlan({ task: 't', steps: [{ action: 'Run Query', sql }] }).errors[0] || '';
  assert.match(one('SELECT 1; DROP TABLE funnel'), /one SQL statement/);
  assert.match(one("ATTACH DATABASE '/tmp/x' AS y"), /must start with SELECT/);
  assert.match(one('SELECT * FROM funnel -- hide'), /comments/);
  assert.match(one("SELECT load_extension('x')"), /blocked keyword/);
  assert.match(one('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c'), /blocked keyword/);
  assert.match(one('SELECT name FROM sqlite_master'), /blocked keyword/);
  assert.equal(one("SELECT 'drop; attach' AS label FROM funnel"), '', 'keywords inside strings are allowed');
  const view = validatePlan({ task: 't', steps: [{ action: 'Create View', sql: 'CREATE VIEW funnel AS SELECT 1' }] });
  assert.match(view.errors[0], /cannot replace the base table/);
  const action = validatePlan({ task: 't', steps: [{ action: 'Shell', command: 'rm -rf /' }] });
  assert.match(action.errors[0], /unsupported action/);
  const cron = validatePlan({ task: 't', steps: [{ action: 'Create View', sql: 'CREATE VIEW v AS SELECT 1 AS x' }, { action: 'Schedule Refresh', schedule: '* * * * *' }] });
  assert.match(cron.errors[0], /at most hourly/);
  assert.equal(validatePlan({ task: 't', steps: [] }).ok, false);
  assert.equal(validatePlan(null).ok, false);
});

test('sandbox tables carry aggregates only, never crew names', () => {
  const tables = sandboxTables(sample);
  const text = JSON.stringify(tables);
  assert.ok(!text.includes('Miguel Torres'));
  assert.ok(tables.won_jobs.length > 0 && tables.funnel.length === 3);
});

test('validate, then run with the matching hash. Staged changes are never applied', async () => {
  const store = memoryAdapter();
  const run = handler(store);
  const validated = await send(run, { action: 'validate', plan });
  assert.equal(validated.status, 200);
  assert.equal(validated.data.validation.ok, true);
  assert.equal((await send(run, { action: 'run', plan, planHash: '0'.repeat(64) })).status, 409);
  const changed = { ...plan, task: 'Changed after review' };
  assert.equal((await send(run, { action: 'run', plan: changed, planHash: validated.data.planHash })).status, 409);
  const { status, data } = await send(run, { action: 'run', plan, planHash: validated.data.planHash });
  assert.equal(status, 200);
  assert.equal(data.outcome, 'passed');
  assert.equal(data.applied, false);
  assert.deepEqual(data.staged.map(s => s.type), ['module-binding', 'refresh-schedule']);
  assert.ok(data.steps[0].rows.some(row => row.pipeline === 'Demolition Bids'));
  assert.equal(data.checks[0].ok, true);
  const log = await (await run(get('/api/jarvis-execute'))).json();
  assert.equal(log.entries[0].outcome, 'passed');
  assert.equal(log.entries[0].by, 'dashboard key');
});

test('the LCP plan validates with a warning and fails safely in the A2Z sandbox', async () => {
  const run = handler();
  const { data } = await send(run, { action: 'validate', plan: lcpPlan });
  assert.equal(data.validation.ok, true);
  assert.match(data.validation.warnings.join(' '), /report field was ignored/);
  assert.equal(data.plan.steps[1].module, 'leads');
  const result = await send(run, { action: 'run', plan: lcpPlan, planHash: data.planHash });
  assert.equal(result.data.outcome, 'failed');
  assert.match(result.data.steps[0].detail, /no such table/);
  assert.equal(result.data.steps.length, 1, 'later steps stop after a failure');
  assert.equal(result.data.staged.length, 0);
});

test('execute endpoint: auth, kill switch, storage failure, time limit', async () => {
  const run = handler();
  assert.equal((await send(run, { action: 'validate', plan }, { 'x-a2z-key': '' })).status, 401);
  assert.equal((await send(run, { action: 'validate', plan }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await send(run, { action: 'validate', plan }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(run, { action: 'apply', plan })).status, 400);
  assert.equal((await send(handler(undefined, { env: { JARVIS_EXECUTE: 'off' } }), { action: 'validate', plan })).status, 403);
  const { data } = await send(run, { action: 'validate', plan });
  const down = createExecuteHandler({ env, openStore: async () => { throw new Error('down'); }, readReport: async () => sample });
  const refused = await send(down, { action: 'run', plan, planHash: data.planHash });
  assert.equal(refused.status, 503, 'no run without an audit record');
  const slow = { task: 'slow', steps: [{ action: 'Run Query', sql: 'SELECT count(*) FROM won_jobs a, won_jobs b, won_jobs c, won_jobs d, won_jobs e, won_jobs f, won_jobs g, won_jobs h, won_jobs i, won_jobs j, won_jobs k' }] };
  const checked = validatePlan(slow);
  await assert.rejects(runPlan(checked.plan, sandboxTables(sample), { timeoutMs: 300 }), /time limit/);
});

test('Supabase adapter maps conditional writes onto PostgREST', async () => {
  const rows = new Map();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ method: init.method || 'GET', url: u, headers: init.headers });
    const key = u.searchParams.get('key')?.slice(3);
    if (!init.method) return Response.json(rows.has(key) ? [rows.get(key)] : []);
    const body = init.body && JSON.parse(init.body);
    if (init.method === 'POST') {
      if (rows.has(body.key) && !u.searchParams.get('on_conflict')) return new Response('', { status: 409 });
      rows.set(body.key, body);
      return new Response(null, { status: 201 });
    }
    if (init.method === 'PATCH') {
      const current = rows.get(key);
      if (!current || current.etag !== u.searchParams.get('etag').slice(3)) return Response.json([]);
      rows.set(key, { ...current, ...body });
      return Response.json([rows.get(key)]);
    }
    rows.delete(key);
    return new Response(null, { status: 204 });
  };
  const store = supabaseStore({ url: 'https://abc.supabase.co', key: 'service-role-key', fetchImpl });
  assert.deepEqual(await store.setJSON('memory/main', { a: 1 }, { onlyIfNew: true }).then(r => r.modified), true);
  assert.equal((await store.setJSON('memory/main', { a: 2 }, { onlyIfNew: true })).modified, false);
  const entry = await store.getWithMetadata('memory/main');
  assert.deepEqual(entry.data, { a: 1 });
  assert.equal((await store.setJSON('memory/main', { a: 3 }, { onlyIfMatch: 'stale' })).modified, false);
  assert.equal((await store.setJSON('memory/main', { a: 3 }, { onlyIfMatch: entry.etag })).modified, true);
  await store.delete('memory/main');
  assert.equal(await store.getWithMetadata('memory/main'), null);
  assert.equal(requests[0].headers.apikey, 'service-role-key');
  assert.equal(requests[0].url.pathname, '/rest/v1/a2z_jarvis_kv');
  assert.throws(() => supabaseStore({ url: 'http://abc.supabase.co', key: 'k' }), /HTTPS/);
  const broken = supabaseStore({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: async () => new Response('', { status: 500 }) });
  await assert.rejects(broken.getWithMetadata('x'), /Supabase HTTP 500/);
});

test('Email agent mailbox: pages from the email app, snapshot cache and stale fallback', async () => {
  const seen = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    seen.push(u.search);
    assert.equal(u.origin, 'https://a2zemails.netlify.app');
    if (!u.searchParams.get('view')) return Response.json({ stats: { unreadIncoming: 4 }, asOf: '2026-11-18T16:00:00Z' });
    const cursor = u.searchParams.get('cursor');
    return Response.json({ messages: [{ id: cursor || 'a', subject: 'Subject ' + (cursor || 'a'), text: 'x'.repeat(2000), receivedAt: '2026-11-18T15:00:00Z' }], nextCursor: cursor ? null : 'p2' });
  };
  const mailEnv = { MCP_COMMAND_CENTER_TOKEN: 'token', JARVIS_EMAIL_PAGES: '3' };
  const snapshot = await fetchMailbox({ env: mailEnv, fetchImpl });
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[0].text.length, 700, 'message text is clipped');
  assert.equal(snapshot.stats.unreadIncoming, 4);
  await assert.rejects(fetchMailbox({ env: {}, fetchImpl }), /MCP_COMMAND_CENTER_TOKEN/);
  await assert.rejects(fetchMailbox({ env: { ...mailEnv, JARVIS_EMAIL_URL: 'http://plain.test' }, fetchImpl }), /HTTPS/);

  const store = memoryAdapter();
  await store.setJSON(MAIL_KEY, { ...snapshot, syncedAt: new Date().toISOString() }, {});
  const count = seen.length;
  await mailboxContext({ env: mailEnv, fetchImpl, store });
  assert.equal(seen.length, count, 'fresh snapshot is reused');
  await store.setJSON(MAIL_KEY, { ...snapshot, syncedAt: '2026-01-01T00:00:00Z' }, {});
  const stale = await mailboxContext({ env: mailEnv, fetchImpl: async () => new Response('', { status: 503 }), store });
  assert.equal(stale.stale, true);
});
