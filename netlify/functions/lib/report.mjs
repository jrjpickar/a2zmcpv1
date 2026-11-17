import { number } from './http.mjs';
import { cashBalance, containerPipelineId, exportFeed, wonSales, makeUsage, netlifyDeploy, siteKeys, source, twilioBalance } from './sources.mjs';
import { containerSales as summarizeContainers, day, funnel, laborSales, pipelineSales, signals, makeCreditBalance, rangeFor, runway, workforce } from './metrics.mjs';

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
    make: [{ date: today, credits: 296 }],
    builds: Object.fromEntries(Object.keys(siteKeys).map(name => [name, { state: 'ready', publishedAt: today, latestState: 'ready' }])),
  };
}

async function readSources(env, today) {
  if (env.DATA_MODE === 'sample') {
    const { builds, ...data } = sample(today);
    const ok = data => ({ status: 'ok', data });
    return { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, ok(v)])), builds: Object.fromEntries(Object.entries(builds).map(([k, v]) => [k, ok(v)])) };
  }

  const signal = AbortSignal.timeout(16000);
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
      if (env.CASH_BALANCE_URL) return source(() => cashBalance(env));
      if (result.status === 'error') return { status: 'error', detail: 'Ledger export unavailable' };
      return { status: 'setup', detail: 'Configure a bank connection on the Ledger' };
    }),
    ledger,
    ghl: source(() => wonSales(env, signal)),
    twilio: source(() => twilioBalance(env)),
    make: source(() => makeUsage(env)),
    builds: Promise.all(Object.entries(siteKeys).map(async ([name, key]) => [name, await source(() => netlifyDeploy(env, key))])).then(Object.fromEntries),
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
  const demonstration = env.DATA_MODE === 'sample';
  const config = demonstration ? {
    MONTHLY_CASH_BURN_USD: '29000',
    MAKE_CYCLE_START: today, MAKE_CYCLE_CREDITS: '5500', NETLIFY_CREDITS_REMAINING: '232', NETLIFY_CREDITS_AS_OF: today,
  } : env;
  const netlifyBalance = number(config.NETLIFY_CREDITS_REMAINING);
  const netlifyDate = day(config.NETLIFY_CREDITS_AS_OF);
  const status = ({ status, detail }) => ({ status, detail });
  const result = {
    mode: demonstration ? 'sample' : 'live',
    range,
    generatedAt: now.toISOString(),
    kpis: {
      funnel: estimating.data ? funnel(estimating.data, range) : null,
      labor: dispatch.data ? laborSales(dispatch.data, range) : null,
      containers: ghl.data ? summarizeContainers(ghl.data.opportunities.filter(r => r.pipelineId === containerPipelineId(config)), range) : null,
      pipelines: ghl.data ? pipelineSales(ghl.data, range, containerPipelineId(config),
        [config.GHL_MULTI_GC_PIPELINE_ID, ...(config.SALES_EXCLUDE_PIPELINE_IDS || '').split(',')].map(x => x?.trim()).filter(x => x && x !== 'off')) : null,
      workforce: dispatch.data ? workforce(dispatch.data, today) : null,
      runway: runway(ledger.data, cash.data, config, today),
    },
    system: {
      sources: Object.fromEntries(Object.entries({ estimating, dispatch, ledger, cash, ghl, twilio, make }).map(([name, state]) => [name, status(state)])),
      deploys: Object.fromEntries(Object.entries(builds).map(([name, result]) => [name, { ...status(result), ...result.data }])),
      make: makeCreditBalance(make.data, config, today),
      netlify: { balance: netlifyDate && netlifyDate <= today && netlifyBalance >= 0 ? netlifyBalance : null,
        asOf: netlifyDate && netlifyDate <= today ? netlifyDate : null, basis: 'Manual billing snapshot' },
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
      labor: 'Confirmed hourly labor bookings made through Dispatch. Booked value, before collections.',
      containers: 'GoHighLevel Container pipeline opportunities currently marked Won. Won value, before collections.',
      pipelines: 'GoHighLevel opportunities currently marked Won, grouped by pipeline and dated by status change. Multiple GCs Bidding is excluded. Won value, before collections. The Labor sales tile uses Dispatch bookings instead.',
      workforce: 'Booked: unique workers assigned to active Dispatch jobs today, excluding workers sent home. Available: active Dispatch roster members with no job today.',
      runway: 'Cash on hand divided by monthly cash burn. The Ledger estimate covers recorded bill payments only.',
    },
  };
  result.signals = signals(result.kpis, result.system);
  return result;
}
