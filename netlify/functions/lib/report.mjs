import { number } from './http.mjs';
import { cashBalance, containerPipelineId, exportFeed, makeAccount, wonSales, netlifyDeploy, siteKeys, source, twilioBalance } from './sources.mjs';
import { containerSales as summarizeContainers, day, funnel, pipelineSales, signals, makeCreditBalance, netlifyCreditBalance, rangeFor, runway, workforce, workforceTrace } from './metrics.mjs';
import { appStore, SETTINGS_KEY } from './store.mjs';
import { HISTORY_KEY, sourceState } from './source-history.mjs';

const cache = new WeakMap();
const ttl = 90_000;

function sample(today) {
  const earlier = new Date(today + 'T00:00:00Z');
  earlier.setUTCDate(earlier.getUTCDate() - 12);
  const salesDay = earlier.toISOString().slice(0, 10);
  const names = ['Miguel Torres', 'Dana Brooks', 'Luis Ortega', 'Sam Patel', 'Rico Alvarez', 'Jordan Lee', 'Tony Nguyen', 'Chris Moreno',
    'Andre Wallace', 'Kim Sato', 'Jose Ramirez', 'Pat Kelly', 'Eddie Flores', 'Marcus Hill'];
  const crew = names.map((name, i) => ({ id: 'w' + i, name, role: i % 8 === 0 ? 'Foreman' : i % 3 ? 'Laborer' : 'Operator' }));
  const bench = ['Ray Castillo', 'Nina Diaz', 'Omar Haddad', 'Leo Grant', 'Tess Romero', 'Victor Cruz', 'Ben Ochoa', 'Gabe Silva']
    .map((name, i) => ({ id: 'b' + i, name, role: i % 3 ? 'Laborer' : 'Operator' }));
  return {
    estimating: { version: 1, mainPipelineId: 'demo', pipelines: [{ id: 'demo', stages: [{ id: 'sent', name: 'Proposal Sent' }] }],
      opportunities: Array.from({ length: 18 }, (_, i) => ({
        id: String(i), pipelineId: 'demo', createdAt: i < 5 ? today : salesDay, stageId: i < 7 ? 'sent' : 'other',
        stageAt: i < 3 ? today : salesDay, status: i >= 14 ? 'won' : 'open', statusAt: today,
      })) },
    dispatch: { jobs: [
      { jobId: 'a', name: 'Harbor Plaza interior demo', active: true, reportDate: today, crew: crew.slice(0, 8) },
      { jobId: 'b', name: 'Bristol St. strip out', active: true, reportDate: today, crew: crew.slice(8, 14) },
    ],
      workers: [...crew, ...bench, { id: 'off', name: 'Off roster', active: false }],
      bookings: [
        { kind: 'job', jobType: 'hourly', at: today, opportunityId: 'lab', monetaryValue: 9200 },
        { kind: 'job', jobType: 'hourly', at: salesDay, opportunityId: 'lab2', monetaryValue: 3600 },
        { kind: 'job', jobType: 'hourly', at: salesDay, opportunityId: 'lab3', monetaryValue: 2150 },
      ],
      health: { pendingGhlScheduleSyncs: 2, makeRuns30d: [{ ok: 113, bad: 3 }] } },
    cash: { balance: 82000, asOf: today + 'T12:00:00Z' },
    ledger: { bills: [{ payments: [{ amount: 87000, date: salesDay }] }] },
    ghl: { pipelines: [{ id: 'demo', name: 'Demolition Bids' }, { id: 'multi', name: 'Multiple GCs Bidding' },
      { id: 'F8i8hB7E5xHrJbJUXFr4', name: 'Containers' }, { id: 'labor', name: 'Labor' }],
    opportunities: [
      { id: 'd1', name: 'Harbor Plaza interior demo', pipelineId: 'demo', status: 'won', value: 48500, at: today },
      { id: 'd2', name: 'Bristol St. retail strip out', pipelineId: 'demo', status: 'won', value: 21750, at: salesDay },
      { id: 'd3', name: 'Fairview office TI demo', pipelineId: 'demo', status: 'won', value: 12400, at: salesDay },
      { id: 'd4', name: 'Newport clinic soft demo', pipelineId: 'demo', status: 'won', value: 6800, at: today },
      { id: 'm1', name: 'Irvine tower bid', pipelineId: 'multi', status: 'won', value: 16200, at: salesDay },
      { id: 'con', name: '40 yd roll off, Main St.', pipelineId: 'F8i8hB7E5xHrJbJUXFr4', status: 'won', value: 5400, at: today },
      { id: 'con2', name: '20 yd roll off, Baker St.', pipelineId: 'F8i8hB7E5xHrJbJUXFr4', status: 'won', value: 1850, at: salesDay },
      { id: 'l1', name: 'Labor crew, Anaheim warehouse', pipelineId: 'labor', status: 'won', value: 9200, at: today },
      { id: 'l2', name: 'Labor crew, Tustin school', pipelineId: 'labor', status: 'won', at: today },
    ] },
    twilio: { balance: 48.72, currency: 'USD', asOf: today },
    make: { usage: [{ date: today, credits: 296 }], org: { allowance: 5500, consumed: 296, lastReset: today.slice(0, 8) + '01T00:00:00Z', nextReset: null, fields: [] } },
    builds: Object.fromEntries(Object.keys(siteKeys).map(name => [name, { state: 'ready', publishedAt: today, latestState: 'ready' }])),
  };
}

async function readSources(env, today) {
  if (env.DATA_MODE === 'sample') {
    const { builds, ...data } = sample(today);
    const ok = data => ({ status: 'ok', data, ms: 0, checkedAt: new Date().toISOString() });
    return { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, ok(v)])), billing: { status: 'ok', data: {} }, builds: Object.fromEntries(Object.entries(builds).map(([k, v]) => [k, ok(v)])) };
  }

  // Whole-read budget, retries included. Netlify keeps it under the 10 s function limit. The VM (A2Z_STORE_DIR set) keeps 16 s.
  const budget = Number(env.SOURCE_BUDGET_MS) || (env.A2Z_STORE_DIR ? 16000 : 9000);
  const signal = AbortSignal.timeout(Math.min(Math.max(budget, 2000), 25000));
  const ledger = source(() => exportFeed(env, 'LEDGER', ['bills'], signal));
  const tasks = {
    estimating: source(() => exportFeed(env, 'ESTIMATING', ['opportunities', 'pipelines'], signal)),
    dispatch: source(() => exportFeed(env, 'DISPATCH', ['jobs', 'bookings'], signal)),
    cash: ledger.then(async result => {
      const bank = result.data?.cashBalance;
      if (bank?.status === 'ok' && bank.currency === 'USD' && Number.isFinite(bank.balance) && day(bank.asOf)) {
        return { status: 'ok', data: { balance: bank.balance, asOf: bank.asOf } };
      }
      if (bank?.status === 'error' || bank?.status === 'ok') {
        return { status: 'error', detail: 'Ledger bank balance unavailable' };
      }
      if (env.CASH_BALANCE_URL) return source(() => cashBalance(env, signal));
      if (result.status === 'error') return { status: 'error', detail: 'Ledger export unavailable' };
      return { status: 'setup', detail: 'Configure a bank connection on the Ledger' };
    }),
    ledger,
    ghl: source(() => wonSales(env, signal)),
    twilio: source(() => twilioBalance(env, signal)),
    make: source(() => makeAccount(env, signal)),
    // Billing inputs saved on the Alerts page. Read with the other sources, so once per cache window.
    billing: env.DATA_MODE === 'test' ? { status: 'ok', data: {} } : appStore().get(SETTINGS_KEY, { type: 'json' }).then(s => ({ status: 'ok', data: s?.billing || {} })).catch(() => ({ status: 'ok', data: {} })),
    builds: Promise.all(Object.entries(siteKeys).map(async ([name, key]) => [name, await source(() => netlifyDeploy(env, key, signal))])).then(Object.fromEntries),
  };
  return Object.fromEntries(await Promise.all(Object.entries(tasks).map(async ([name, task]) => [name, await task])));
}

function cachedSources(env, today) {
  const previous = cache.get(env);
  if (previous?.today === today && (!previous.finishedAt || Date.now() - previous.finishedAt < ttl)) return previous.promise;
  const record = { today, finishedAt: null };
  record.promise = readSources(env, today).then(result => {
    record.finishedAt = Date.now();
    return result;
  }).catch(error => {
    if (cache.get(env) === record) cache.delete(env);
    throw error;
  });
  cache.set(env, record);
  return record.promise;
}

export async function report(input = {}, env = process.env, now = new Date()) {
  const range = rangeFor(input, now);
  const today = day(now);
  const sources = await cachedSources(env, today);
  const { estimating, dispatch, ledger, cash, ghl, twilio, make, builds } = sources;
  const billing = sources.billing?.data || {};
  const demonstration = env.DATA_MODE === 'sample';
  const config = demonstration ? {
    MONTHLY_CASH_BURN_USD: '29000',
    MAKE_CYCLE_START: today, MAKE_CYCLE_CREDITS: '5500', NETLIFY_CREDITS_REMAINING: '232', NETLIFY_CREDITS_AS_OF: today,
  } : env;
  const status = ({ status, detail }) => ({ status, detail });
  // All sales values come from GoHighLevel won opportunities. The Labor pipeline is Labor sales; the rest are pipeline sales.
  const sales = { pipelines: null, labor: null };
  if (ghl.data) {
    const all = pipelineSales(ghl.data, range, containerPipelineId(config),
      [config.GHL_MULTI_GC_PIPELINE_ID, ...(config.SALES_EXCLUDE_PIPELINE_IDS || '').split(',')].map(x => x?.trim()).filter(x => x && x !== 'off'));
    const laborId = config.LABOR_PIPELINE_ID?.trim();
    const isLabor = p => laborId ? p.id === laborId : /\blabou?r\b/i.test(p.name);
    const labor = all.find(isLabor);
    sales.pipelines = all.filter(p => p !== labor);
    sales.labor = labor ? { pipelineId: labor.id, name: labor.name, count: labor.count, amount: labor.amount, missingValue: labor.missingValue,
      missingDate: labor.missingDate, jobs: labor.jobs, jobsMore: labor.jobsMore } : null;
  }
  const result = {
    mode: demonstration ? 'sample' : 'live',
    range,
    generatedAt: now.toISOString(),
    kpis: {
      funnel: estimating.data ? funnel(estimating.data, range) : null,
      labor: sales.labor,
      containers: ghl.data ? summarizeContainers(ghl.data.opportunities.filter(r => r.pipelineId === containerPipelineId(config)), range) : null,
      pipelines: sales.pipelines,
      workforce: dispatch.data ? workforce(dispatch.data, today) : null,
      runway: runway(ledger.data, cash.data, config, today),
    },
    system: {
      sources: Object.fromEntries(Object.entries({ estimating, dispatch, ledger, cash, ghl, twilio, make }).map(([name, state]) => [name, status(state)])),
      deploys: Object.fromEntries(Object.entries(builds).map(([name, result]) => [name, { ...status(result), ...result.data }])),
      make: makeCreditBalance(make.data, config, today, billing),
      netlify: netlifyCreditBalance(config, today, billing),
      twilio: twilio.data ?? null,
      dispatch: dispatch.data?.health && {
        pendingSyncs: number(dispatch.data.health.pendingGhlScheduleSyncs),
        makeRuns30d: (dispatch.data.health.makeRuns30d || []).reduce((total, row) => ({
          ok: total.ok + (number(row.ok) || 0), bad: total.bad + (number(row.bad) || 0),
        }), { ok: 0, bad: 0 }),
      },
    },
    definitions: {
      leads: 'New opportunities in the primary Estimating pipeline, by creation date.',
      proposals: 'One per bid opportunity. Uses saved proposal events and current Proposal Sent timestamps, including additional GC bids.',
      wins: 'One per awarded job opportunity. Uses saved award events and current primary-pipeline win or award timestamps.',
      labor: 'GoHighLevel Labor pipeline opportunities currently marked Won, dated by status change. Won value, before collections.',
      containers: 'GoHighLevel Container pipeline opportunities currently marked Won. Won value, before collections.',
      pipelines: 'GoHighLevel opportunities currently marked Won, grouped by pipeline and dated by status change. Multiple GCs Bidding, Hiring and New Customer are excluded. Won value, before collections. The Labor pipeline is shown as Labor sales instead.',
      workforce: 'Read the same way as the Dispatch board. Booked: workers on open jobs that hold today, including multi-day jobs started earlier and undated open jobs, minus anyone sent home. Available: the board labor roster (plus manual workers, minus hidden) not booked today.',
      runway: 'Cash on hand divided by monthly cash burn. The Ledger estimate covers recorded bill payments only.',
    },
  };
  result.signals = signals(result.kpis, result.system);
  return result;
}

// ---------------- diagnostics ----------------
const has = (env, ...keys) => Object.fromEntries(keys.map(k => [k, Boolean(env[k]?.trim?.())]));
const count = v => Array.isArray(v) ? v.length : null;
const labels = { estimating: 'Estimating Desk export', dispatch: 'Dispatch export', ledger: 'Ledger export', cash: 'Bank cash balance',
  ghl: 'GoHighLevel opportunities', twilio: 'Twilio balance API', make: 'Make usage API' };

function records(name, data, today) {
  if (!data) return null;
  if (name === 'estimating') return { opportunities: count(data.opportunities), pipelines: count(data.pipelines), events: count(data.history?.events) };
  if (name === 'dispatch') {
    const roster = ['workers', 'roster', 'employees', 'crewMembers', 'laborers'].find(k => Array.isArray(data[k]));
    const t = workforceTrace(data, today);
    return { jobsOnBoard: t.jobs, jobsHoldingCrewToday: t.today, crewToday: t.crewEntries, carriedOverFromEarlierDay: t.carriedOver, undatedOpen: t.noDate,
      skippedClosed: t.inactive, skippedOtherDay: t.otherDay, skippedStale: t.stale, skippedNoCrew: t.noCrew, datesSeen: t.datesSeen,
      laborRoster: Array.isArray(data.rosters?.labor?.data) || data.rosters?.labor?.data ? 'cached' : 'not cached yet', roster: roster ? data[roster].length : 'missing', exportKeys: t.exportKeys, jobFields: t.jobFields, crewFields: t.crewFields };
  }
  if (name === 'ledger') return { bills: count(data.bills), bankStatus: data.cashBalance?.status || 'not sent' };
  if (name === 'ghl') return { wonOpportunities: count(data.opportunities), pipelines: count(data.pipelines) };
  if (name === 'make') return { days: count(data.usage), credits30d: Math.round((data.usage || []).reduce((t, r) => t + r.credits, 0)),
    planAllowance: data.org?.allowance ?? 'not reported', consumed: data.org?.consumed ?? 'not reported', lastReset: data.org?.lastReset?.slice(0, 10) || 'not reported',
    organizationFields: data.org ? data.org.fields.join(', ') || 'none' : 'organization call failed' };
  if (name === 'twilio') return { balance: data.balance, currency: data.currency };
  if (name === 'cash') return { balance: data.balance, asOf: data.asOf };
  return null;
}

// What the Diagnostics tab shows. fresh=true skips the 90 second cache for one full re-read.
export async function diagnostics({ env = process.env, now = new Date(), fresh = false, fetchImpl = fetch } = {}) {
  const today = day(now);
  if (fresh) cache.delete(env);
  const started = Date.now();
  const sources = await cachedSources(env, today);
  const cached = cache.get(env);
  const { builds, billing, ...feeds } = sources;
  const checks = Object.entries(feeds).map(([name, r]) => ({ id: 'source:' + name, group: 'Data sources', label: labels[name] || name,
    status: r.status, detail: r.detail || null, ms: r.ms ?? null, checkedAt: r.checkedAt || null, records: records(name, r.data, today) }));
  // Uptime and state per source from the alert check samples (Diagnostics only, best effort).
  const history = env.DATA_MODE === 'test' ? null : await appStore().get(HISTORY_KEY, { type: 'json' }).catch(() => null);
  for (const check of checks) {
    const state = sourceState(history?.[check.id.slice('source:'.length)], Number(env.SOURCE_DOWN_AFTER) || 1);
    if (state) check.records = { ...check.records, state: state.state, uptime24h: state.uptime24h == null ? null : state.uptime24h + '%', checks24h: state.checks24h };
  }
  for (const [name, r] of Object.entries(builds)) checks.push({ id: 'deploy:' + name, group: 'Deploys', label: name + ' production deploy',
    status: r.status === 'ok' ? (r.data.state === 'ready' ? 'ok' : 'error') : r.status, detail: r.detail || (r.data && ['state ' + r.data.state,
      r.data.latestState && r.data.latestState !== r.data.state && 'latest build ' + r.data.latestState].filter(Boolean).join(', ')) || null,
    ms: r.ms ?? null, checkedAt: r.checkedAt || null, records: r.data ? { publishedAt: r.data.publishedAt } : null });
  // Groq: checks the key and model with the free models endpoint, only on a fresh run.
  const model = env.GROQ_MODEL || 'openai/gpt-oss-120b';
  let groq = { status: env.GROQ_API_KEY ? 'ok' : 'setup', detail: env.GROQ_API_KEY ? 'Key set. Run a fresh check to verify it' : 'GROQ_API_KEY is not set for functions' };
  if (env.GROQ_API_KEY && fresh && env.DATA_MODE !== 'sample') {
    const t0 = Date.now();
    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/models/' + encodeURIComponent(model), { headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY }, signal: AbortSignal.timeout(8000) });
      groq = res.ok ? { status: 'ok', detail: 'Key valid, model available' } : { status: 'error', detail: res.status === 401 ? 'Groq rejected the key' : res.status === 404 ? 'Model ' + model + ' not available' : 'Groq HTTP ' + res.status };
    } catch { groq = { status: 'error', detail: 'Groq unreachable' }; }
    groq.ms = Date.now() - t0;
  }
  checks.push({ id: 'groq', group: 'Services', label: 'Groq (' + model + ')', ...groq, checkedAt: now.toISOString() });
  const config = {
    Dashboard: has(env, 'DASHBOARD_KEY', 'MCP_KEY'),
    'Estimating Desk': has(env, 'ESTIMATING_URL', 'ESTIMATING_EXPORT_KEY'),
    Dispatch: has(env, 'DISPATCH_URL', 'DISPATCH_EXPORT_KEY'),
    Ledger: has(env, 'LEDGER_URL', 'LEDGER_EXPORT_KEY'),
    GoHighLevel: has(env, 'GHL_PIT_TOKEN', 'GHL_LOCATION_ID', 'CONTAINER_PIPELINE_ID'),
    Twilio: has(env, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'),
    Make: has(env, 'MAKE_ZONE', 'MAKE_ORG_ID', 'MAKE_API_TOKEN'),
    Netlify: has(env, 'NETLIFY_ACCESS_TOKEN', 'ESTIMATING_NETLIFY_SITE_ID', 'DISPATCH_NETLIFY_SITE_ID', 'LEDGER_NETLIFY_SITE_ID'),
    'Billing inputs (Alerts page)': { netlifyCreditsRemaining: billing?.data?.netlifyCreditsRemaining != null, makeCycleCredits: billing?.data?.makeCycleCredits != null },
    Groq: has(env, 'GROQ_API_KEY', 'GROQ_MODEL'),
  };
  return {
    mode: env.DATA_MODE === 'sample' ? 'sample' : 'live', generatedAt: now.toISOString(), fresh, totalMs: Date.now() - started,
    cache: { ageSeconds: cached?.finishedAt ? Math.round((Date.now() - cached.finishedAt) / 1000) : null, ttlSeconds: ttl / 1000 },
    runtime: { node: process.version, context: env.CONTEXT || null, commit: env.COMMIT_REF ? env.COMMIT_REF.slice(0, 7) : null, deployId: env.DEPLOY_ID || null },
    checks, config,
  };
}
