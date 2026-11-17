import assert from 'node:assert/strict';
import { test } from 'node:test';
import { day, funnel, makeCreditBalance, rangeFor, runway, workforce } from '../netlify/functions/lib/metrics.mjs';
import { report } from '../netlify/functions/lib/report.mjs';
import metrics from '../netlify/functions/metrics.mjs';
import mcp from '../netlify/functions/mcp.mjs';

const now = new Date('2026-11-16T02:30:00Z');
const today = '2026-11-15';
const range = rangeFor({ preset: 'mtd' }, now);

test('Pacific boundaries, Monday week start, and invalid dates', () => {
  assert.equal(day(now), today);
  assert.deepEqual(rangeFor({ preset: 'wtd' }, now), { from: '2026-11-09', to: today });
  assert.throws(() => rangeFor({ from: '2026-02-30', to: today }, now), RangeError);
  assert.throws(() => rangeFor({ from: today, to: '2026-11-16' }, now), RangeError);
});

test('funnel keeps stage transitions after advancement and deduplicates a retry', () => {
  const data = {
    mainPipelineId: 'main',
    pipelines: [{ id: 'main', stages: [{ id: 'sent', name: 'Proposal Sent' }] }],
    opportunities: [
      { id: 'A', createdAt: today, pipelineId: 'main', stageId: 'working', status: 'open' },
      { id: 'B', createdAt: '2026-10-25', pipelineId: 'main', stageId: 'sent', stageAt: today },
      { id: 'C', createdAt: today, pipelineId: 'other' },
    ],
    history: { status: 'enabled', events: [
      { id: 'A', type: 'proposal', at: '2026-11-05' }, { id: 'A', type: 'proposal', at: '2026-11-05' },
      { id: 'A', type: 'award', at: '2026-11-12' }, { id: 'B', type: 'proposal', at: '2026-10-30' },
    ] },
  };
  assert.deepEqual(funnel(data, range), { leads: 1, proposals: 1, wins: 1, eventHistory: 'enabled' });
});

test('active workforce dedupes crews and excludes sent-home and inactive crew', () => {
  const job = { active: true, reportDate: today, crew: [{ id: 'x', name: 'Ana Ruiz', role: 'Foreman' }, { id: 'y' }], sentHome: [{ id: 'y', reportDate: today }] };
  const wf = workforce({ jobs: [{ ...job, jobId: 'a', name: 'Harbor Plaza' }] }, today);
  assert.match(wf.crew[0].key, /^[\w-]{10}$/);
  assert.notEqual(wf.crew[0].key, 'x');
  assert.deepEqual(workforce({ jobs: [
    { ...job, jobId: 'a', name: 'Harbor Plaza' }, { ...job, jobId: 'b' },
    { ...job, jobId: 'c', active: false }, { ...job, reportDate: '2026-11-16', jobId: 'd' },
  ] }, today), { workers: 1, booked: 1, available: null, jobs: 2, asOf: today, crew: [{ key: wf.crew[0].key, name: 'Ana Ruiz', role: 'Foreman', job: 'Harbor Plaza' }], bench: [] });
  const roster = [{ id: 'x', name: 'Ana Ruiz' }, { id: 'y', name: 'Bo Kim' }, { id: 'z', name: 'Cy Day', role: 'Operator' }, { id: 'q', active: false }, { id: 'r', available: false }];
  const split = workforce({ jobs: [{ ...job, jobId: 'a' }], workers: roster }, today);
  assert.equal(split.booked, 1);
  assert.deepEqual(split.bench.map(({ key, ...p }) => p), [{ name: 'Bo Kim', role: null }, { name: 'Cy Day', role: 'Operator' }]);
  assert.equal(split.bench[0].key, workforce({ jobs: [], workers: roster }, today).bench[1].key, 'keys stay stable when a worker changes status');
  assert.equal(split.available, 2);
});

test('cash requires an as-of date, and Make does not extrapolate incomplete usage', () => {
  const ledger = { bills: [{ payments: [{ date: '2026-11-14', amount: 9000 }, { date: '2026-08-01', amount: 87000 }] }] };
  const estimate = runway(ledger, { balance: 9000, asOf: today }, {}, today);
  assert.equal(estimate.months, 3);
  assert.equal(estimate.estimated, true);
  assert.equal(runway(ledger, { balance: 9000 }, {}, today).months, null);
  const usage = [{ date: today, credits: 19 }];
  assert.equal(makeCreditBalance(usage, { MAKE_CYCLE_START: '2026-11-01', MAKE_CYCLE_CREDITS: '100' }, today).balance, 81);
  assert.equal(makeCreditBalance(usage, { MAKE_CYCLE_START: '2026-10-01', MAKE_CYCLE_CREDITS: '100' }, today).balance, null);
});

test('sample is explicit, while absent live sources stay unavailable', async () => {
  const demo = await report({}, { DATA_MODE: 'sample' }, now);
  assert.equal(demo.kpis.workforce.workers, 14);
  assert.equal(demo.kpis.workforce.available, 8);
  assert.equal(demo.system.twilio.balance, 48.72);
  assert.equal(demo.kpis.containers.amount, 7250);
  assert.equal(demo.kpis.pipelines.length, 2);
  assert.deepEqual([demo.kpis.labor.amount, demo.kpis.labor.count, demo.kpis.labor.missingValue], [9200, 2, 1]);
  assert.ok(!demo.kpis.pipelines.some(p => /multiple/i.test(p.name)));
  const demoJobs = demo.kpis.pipelines.find(p => p.name === 'Demolition Bids').jobs;
  assert.deepEqual(demoJobs.map(j => j.value), [48500, 21750, 12400, 6800]);
  assert.equal(demo.kpis.labor.jobs.at(-1).value, null);
  const live = await report({}, {}, now);
  assert.equal(live.mode, 'live');
  assert.equal(live.kpis.labor, null);
  assert.equal(live.kpis.runway.months, null);
  assert.equal(live.system.sources.ghl.status, 'setup');
});

test('live pulls are authenticated, cached, and isolate Twilio failure from the other sources', async t => {
  const env = {
    ESTIMATING_URL: 'https://estimating.test', ESTIMATING_EXPORT_KEY: 'estimating-test-key',
    DISPATCH_URL: 'https://dispatch.test', DISPATCH_EXPORT_KEY: 'dispatch-example-key',
    CASH_BALANCE_URL: 'https://balance.test/available', CASH_BALANCE_TOKEN: 'balance-example-token', MONTHLY_CASH_BURN_USD: '3000',
    GHL_PIT_TOKEN: 'ghl-example-token', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'twilio-example-token',
    ESTIMATING_NETLIFY_SITE_ID: 'demo-est', NETLIFY_ACCESS_TOKEN: 'netlify-example-token',
  };
  const rows = {
    'estimating.test': { version: 1, mainPipelineId: 'p', pipelines: [{ id: 'p', stages: [] }], opportunities: [] },
    'dispatch.test': { version: 1, jobs: [], bookings: [
      { kind: 'job', at: today, opportunityId: 'labor', monetaryValue: 250 },
      { kind: 'job', at: today, opportunityId: 'labor', monetaryValue: 250 },
    ] },
  };
  const fetch = t.mock.method(globalThis, 'fetch', async (raw, options) => {
    const url = new URL(raw);
    if (url.hostname === 'balance.test') {
      assert.equal(options.headers.Authorization, 'Bearer ' + env.CASH_BALANCE_TOKEN);
      return Response.json({ balance: 9000, currency: 'USD', asOf: '2026-11-15T18:00:00Z' });
    }
    if (rows[url.hostname]) {
      assert.equal(options.headers['x-metrics-key'], url.hostname === 'dispatch.test' ? env.DISPATCH_EXPORT_KEY : env.ESTIMATING_EXPORT_KEY);
      return Response.json(rows[url.hostname]);
    }
    if (url.hostname === 'services.leadconnectorhq.com') {
      assert.equal(options.headers.Authorization, 'Bearer ' + env.GHL_PIT_TOKEN);
      if (url.pathname === '/opportunities/pipelines') return Response.json({ pipelines: [{ id: 'F8i8hB7E5xHrJbJUXFr4', name: 'Containers' }, { id: 'main', name: 'Demolition' }, { id: 'lab', name: 'Labor' }] });
      assert.equal(url.searchParams.has('pipeline_id'), false);
      return Response.json({ opportunities: [
        { id: '1', pipelineId: 'F8i8hB7E5xHrJbJUXFr4', status: 'won', lastStatusChangeAt: today, monetaryValue: 400 },
        { id: '2', pipelineId: 'main', status: 'won', lastStatusChangeAt: today, monetaryValue: 1500 },
        { id: '3', pipelineId: 'main', status: 'won', lastStatusChangeAt: '2026-10-02', monetaryValue: 900 },
        { id: '4', pipelineId: 'lab', status: 'won', lastStatusChangeAt: today, monetaryValue: 700 },
        { id: '4', pipelineId: 'lab', status: 'won', lastStatusChangeAt: today, monetaryValue: 700 },
      ], meta: { total: 4 } });
    }
    if (url.hostname === 'api.twilio.com') return Response.json({}, { status: 403 });
    if (url.hostname === 'api.netlify.com') {
      return Response.json(url.pathname.endsWith('/deploys') ? [{ context: 'production', state: 'error' }]
        : { id: 'demo-est', published_deploy: { state: 'ready' } });
    }
    throw new Error('Unexpected host');
  });
  const response = await report({}, env, now);
  assert.equal(response.kpis.runway.months, 3);
  assert.equal(response.kpis.runway.asOf, '2026-11-15T18:00:00.000Z');
  // Labor comes from the GHL Labor pipeline only, once per opportunity, never from Dispatch bookings.
  assert.equal(response.kpis.labor.amount, 700);
  assert.equal(response.kpis.labor.count, 1);
  assert.ok(!response.kpis.pipelines.some(p => p.name === 'Labor'));
  assert.equal(response.kpis.containers.amount, 400);
  assert.deepEqual(response.kpis.pipelines.map(p => [p.name, p.count, p.amount]), [['Demolition', 1, 1500], ['Containers', 1, 400]]);
  assert.deepEqual(response.kpis.pipelines[0].jobs, [{ id: '2', name: 'Untitled opportunity', value: 1500, at: today }]);
  assert.equal(response.system.sources.twilio.detail, 'Upstream HTTP 403');
  assert.equal(response.system.deploys.Estimating.state, 'ready');
  assert.equal(response.system.deploys.Estimating.latestState, 'error');
  const calls = fetch.mock.callCount();
  await report({ preset: 'today' }, env, now);
  assert.equal(fetch.mock.callCount(), calls);
});

test('dashboard and MCP require separate keys in live mode', async t => {
  const env = process.env;
  const previous = { DATA_MODE: env.DATA_MODE, DASHBOARD_KEY: env.DASHBOARD_KEY, MCP_KEY: env.MCP_KEY };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });
  env.DATA_MODE = 'live';
  env.DASHBOARD_KEY = 'dashboard-test-key';
  env.MCP_KEY = 'another-mcp-test-key';
  const url = 'https://demo.test';
  assert.equal((await metrics(new Request(url + '/api/metrics'))).status, 401);
  assert.equal((await metrics(new Request(url + '/api/metrics?preset=bad', { headers: { 'x-a2z-key': env.DASHBOARD_KEY } }))).status, 400);
  const request = key => new Request(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal((await mcp(request(env.DASHBOARD_KEY))).status, 401);
  assert.equal((await (await mcp(request(env.MCP_KEY))).json()).result.tools[0].name, 'a2z_operating_report');
});

test('MCP derives runway from the protected Ledger export and rejects a failed bank total', async t => {
  const env = { LEDGER_URL: 'https://ledger.test', LEDGER_EXPORT_KEY: 'test-ledger-key',
    MONTHLY_CASH_BURN_USD: '3000', CASH_BALANCE_URL: 'https://previous.test' };
  let cashBalance = { status: 'ok', balance: 9000, currency: 'USD', asOf: '2026-11-15T18:00:00Z' };
  const fetch = t.mock.method(globalThis, 'fetch', async (raw, opts) => {
    assert.equal(new URL(raw).hostname, 'ledger.test');
    assert.equal(opts.headers['x-metrics-key'], env.LEDGER_EXPORT_KEY);
    return Response.json({ version: 1, bills: [], cashBalance });
  });
  const result = await report({}, env, now);
  assert.equal(result.kpis.runway.months, 3);
  assert.equal(result.kpis.runway.asOf, cashBalance.asOf);
  assert.equal(fetch.mock.callCount(), 1);
  cashBalance = { status: 'error' };
  const failed = await report({}, { ...env }, now);
  assert.equal(failed.kpis.runway.months, null);
  assert.equal(failed.system.sources.cash.status, 'error');
  assert.equal(failed.system.sources.ledger.status, 'ok');
  assert.equal(fetch.mock.callCount(), 2);
});
