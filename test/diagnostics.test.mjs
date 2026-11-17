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

import { makeCreditBalance, netlifyCreditBalance, workforceTrace } from '../netlify/functions/lib/metrics.mjs';
import { makeOrganization } from '../netlify/functions/lib/sources.mjs';
import { sanitize } from '../netlify/functions/lib/alerts.mjs';

test('matches the Dispatch board: past-dated open jobs still hold crew, undated open jobs count, closed and stale rows do not', () => {
  const today = '2026-11-16';
  const wf = workforce({
    jobs: [
      { jobId: 'multi', reportDate: '2026-11-12', active: true, jobAddress: '12 Main St', updatedAt: '2026-11-15T20:00:00Z', crew: [{ id: 'c1', name: 'Ana Ruiz', phone: '+1 (714) 555-0101' }] },
      { jobId: 'nodate', reportDate: '', active: true, updatedAt: '2026-11-16T01:00:00Z', crew: [{ id: 'c2', name: 'Bo Kim', phone: '7145550102' }] },
      { jobId: 'night', reportDate: '2026-11-15', reportTime: '22:00', reportEndTime: '06:00', nightWork: true, active: true, crew: [{ id: 'c3', name: 'Cy Day' }] },
      { jobId: 'closed', reportDate: today, active: false, crew: [{ id: 'c4', name: 'Dee' }] },
      { jobId: 'old', reportDate: '2026-09-01', active: true, updatedAt: '2026-09-02T00:00:00Z', crew: [{ id: 'c5', name: 'Eve' }] },
      { jobId: 'later', reportDate: '2026-11-18', active: true, crew: [{ id: 'c6', name: 'Fay' }] },
      { jobId: 'dup', reportDate: today, active: true, crew: [{ id: 'other-id', name: 'ana ruiz', phone: '17145550101' }],
        sentHome: [] },
    ],
    rosters: { labor: { data: { labor: [{ id: 'c1', name: 'Ana Ruiz', phone: '7145550101' }, { id: 'c6', name: 'Fay' }, { id: 'h1', name: 'Hidden Guy' }] } } },
    manualWorkers: [{ contactId: 'm1', name: 'Gus', phone: '7145550199', isLabor: true }],
    hiddenWorkers: [{ role: 'labor', name: 'Hidden Guy' }],
  }, today);
  assert.deepEqual(wf.crew.map(c => c.name).sort(), ['Ana Ruiz', 'Bo Kim', 'Cy Day']);
  assert.equal(wf.crew.find(c => c.name === 'Ana Ruiz').job, '12 Main St');
  assert.deepEqual(wf.bench.map(c => c.name).sort(), ['Fay', 'Gus']);
  assert.equal(wf.jobs, 4);
});

test('Dispatch board shapes: board by date and flat assignments both count crew', () => {
  const today = '2026-11-16';
  const byDate = workforce({ board: { [today]: [{ id: 'j1', title: 'Harbor', assigned: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bo' }] }], '2026-11-17': [{ id: 'j2', crew: [{ id: 'c' }] }] } }, today);
  assert.equal(byDate.booked, 2);
  assert.equal(byDate.crew[0].job, 'Harbor');
  const flat = workforce({ assignments: [
    { jobId: 'x', jobName: 'Main', date: today, workerId: 'a', workerName: 'Ana' }, { jobId: 'x', date: today, workerId: 'b', workerName: 'Bo' },
    { jobId: 'y', date: '2026-11-17', workerId: 'c', workerName: 'Cy' }], workers: [{ id: 'c', name: 'Cy' }] }, today);
  assert.deepEqual([flat.booked, flat.jobs, flat.available], [2, 1, 1]);
  const trace = workforceTrace({ jobs: [{ jobId: 1, reportDate: '2026-11-10', crew: [] }, { jobId: 2, crew: [{ id: 'a' }] }] }, today);
  assert.deepEqual([trace.noCrew, trace.today, trace.noDate, trace.datesSeen], [1, 1, 1, '2026-11-10 to 2026-11-10']);
  assert.match(trace.exportKeys, /jobs\[2\]/);
});

test('Make credits come from the organization when it reports allowance and use', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://us2.make.com/api/v2/organizations/7');
    return Response.json({ organization: { id: 7, license: { operations: '10000' }, consumedOperations: 2500, lastReset: '2026-11-01T00:00:00Z', nextReset: '2026-12-01T00:00:00Z' } });
  });
  const org = await makeOrganization({ MAKE_ZONE: 'us2.make.com', MAKE_ORG_ID: '7', MAKE_API_TOKEN: 'x' });
  const live = makeCreditBalance({ usage: [], org }, {}, '2026-11-16');
  assert.deepEqual([live.balance, live.basis, live.nextReset], [7500, 'Live from Make organization', '2026-11-30']);
  const fromUsage = makeCreditBalance({ usage: [{ date: '2026-11-02', credits: 40 }, { date: '2026-10-30', credits: 99 }], org: { allowance: null, consumed: null, lastReset: '2026-11-01T00:00:00Z' } },
    {}, '2026-11-16', { makeCycleCredits: 100 });
  assert.equal(fromUsage.balance, 60);
  assert.match(makeCreditBalance({ usage: [], org: null }, {}, '2026-11-16').basis, /Billing inputs/);
});

test('Netlify credits use the snapshot saved on the Alerts page', () => {
  assert.equal(netlifyCreditBalance({}, '2026-11-16').balance, null);
  const n = netlifyCreditBalance({ NETLIFY_CREDITS_REMAINING: '5' }, '2026-11-16', { netlifyCreditsRemaining: 812, netlifyCreditsAsOf: '2026-11-14' });
  assert.deepEqual([n.balance, n.ageDays], [812, 2]);
  assert.throws(() => sanitize({ billing: { netlifyCreditsRemaining: 10 } }), /date/);
  assert.deepEqual(sanitize({ billing: { netlifyCreditsRemaining: '10', netlifyCreditsAsOf: '2026-11-16', makeCycleCredits: '' } }).billing, { netlifyCreditsRemaining: 10, netlifyCreditsAsOf: '2026-11-16' });
});
