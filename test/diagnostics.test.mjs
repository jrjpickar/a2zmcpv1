import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUsage, makeZone, source } from '../netlify/functions/lib/sources.mjs';
import { pipelineSales, workforce } from '../netlify/functions/lib/metrics.mjs';
import diagnosticsApi from '../netlify/functions/diagnostics.mjs';

const memory = () => { const m = new Map(); return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } }; };

test('Make zone accepts pasted URLs and usage tolerates string, missing and timestamp fields', async t => {
  assert.equal(makeZone('https://us2.make.com/api/v2'), 'us2.make.com');
  assert.equal(makeZone(' EU1.make.com '), 'eu1.make.com');
  assert.throws(() => makeZone('make.com'), /MAKE_ZONE/);
  const env = { MAKE_ZONE: 'https://us2.make.com/', MAKE_ORG_ID: '123', MAKE_API_TOKEN: 'Token abc' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://us2.make.com/api/v2/organizations/123/usage?organizationTimezone=true');
    assert.equal(init.headers.Authorization, 'Token abc');
    return Response.json({ data: [{ date: '2026-11-15T00:00:00.000Z', centicredits: '2950' }, { date: '2026-11-14', operations: 12 }, { date: 'bad' }] });
  });
  assert.deepEqual(await makeUsage(env), [{ date: '2026-11-15', credits: 29.5 }, { date: '2026-11-14', credits: 12 }]);
});

test('Make errors explain the fix', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  const r = await source(() => makeUsage({ MAKE_ZONE: 'us2.make.com', MAKE_ORG_ID: '1', MAKE_API_TOKEN: 'x' }));
  assert.equal(r.status, 'error');
  assert.match(r.detail, /organizations:read/);
  assert.ok(Number.isFinite(r.ms));
});

test('Hiring, New Customer and Multiple GCs pipelines are not sales', () => {
  const data = { pipelines: [{ id: 'a', name: 'Demolition' }, { id: 'h', name: 'Hiring' }, { id: 'n', name: 'New Customers' }, { id: 'm', name: 'Multiple GCs Bidding' }],
    opportunities: [{ id: '1', pipelineId: 'a', status: 'won', value: 5, at: '2026-11-10' }, { id: '2', pipelineId: 'h', status: 'won', value: 9, at: '2026-11-10' }, { id: '3', pipelineId: 'n', status: 'won', value: 9, at: '2026-11-10' }] };
  assert.deepEqual(pipelineSales(data, { from: '2026-11-01', to: '2026-11-16' }).map(p => p.name), ['Demolition']);
});

test('workforce reads timestamp report dates and other Dispatch field names', () => {
  const today = '2026-11-16';
  const wf = workforce({
    jobs: [{ jobId: 'j', title: 'Main St.', reportDate: '2026-11-16T14:00:00.000Z', workers: [{ workerId: 'w1', firstName: 'Ana', lastName: 'Ruiz' }] },
      { jobId: 'k', status: 'cancelled', reportDate: today, crew: [{ id: 'w2', name: 'Bo' }] }],
    roster: [{ id: 'w1', name: 'Ana Ruiz' }, { workerId: 'w3', fullName: 'Cy Day' }, { id: 'w4', name: 'Old', status: 'Inactive' }],
  }, today);
  assert.equal(wf.booked, 1);
  assert.equal(wf.crew[0].name, 'Ana Ruiz');
  assert.equal(wf.crew[0].job, 'Main St.');
  assert.deepEqual(wf.bench.map(p => p.name), ['Cy Day']);
});

test('diagnostics needs the key, lists every source and never returns secret values', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, { DATA_MODE: 'sample', DASHBOARD_KEY: 'dashboard-test-key', GROQ_API_KEY: 'gsk_secret_value' });
  const call = key => diagnosticsApi(new Request('https://a.test/api/diagnostics', { headers: key ? { 'x-a2z-key': key } : {} }), { store: memory() });
  assert.equal((await call()).status, 401);
  const res = await call(process.env.DASHBOARD_KEY);
  const text = await res.clone().text();
  const body = await res.json();
  assert.ok(!text.includes('gsk_secret_value') && !text.includes('dashboard-test-key'));
  for (const id of ['source:estimating', 'source:dispatch', 'source:make', 'deploy:Ledger', 'groq', 'blobs', 'alerts']) assert.ok(body.checks.some(c => c.id === id), id);
  assert.equal(body.config.Groq.GROQ_API_KEY, true);
  assert.equal(body.checks.find(c => c.id === 'source:dispatch').records.roster, 9 + 14);
});
