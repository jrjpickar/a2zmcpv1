import { number } from './http.mjs';
import { containerSales, exportFeed, makeUsage, netlifyDeploy, siteKeys, source, twilioBalance } from './sources.mjs';
import { containerSales as summarizeContainers, day, funnel, laborSales, makeCreditBalance, rangeFor, runway, workforce } from './metrics.mjs';

const cache = new WeakMap();
const ttl = 90_000;

function sample(today) {
  const earlier = new Date(today + 'T00:00:00Z');
  earlier.setUTCDate(earlier.getUTCDate() - 12);
  const salesDay = earlier.toISOString().slice(0, 10);
  return {
    estimating: { version: 1, mainPipelineId: 'demo', pipelines: [{ id: 'demo', stages: [{ id: 'sent', name: 'Proposal Sent' }] }],
      opportunities: Array.from({ length: 18 }, (_, i) => ({
        id: String(i), pipelineId: 'demo', createdAt: i < 5 ? today : salesDay, stageId: i < 7 ? 'sent' : 'other',
        stageAt: i < 3 ? today : salesDay, status: i >= 14 ? 'won' : 'open', statusAt: today,
      })) },
    dispatch: { jobs: [{ jobId: 'a', active: true, reportDate: today, crew: Array.from({ length: 14 }, (_, id) => ({ id: 'w' + id })) }],
      bookings: [{ kind: 'job', jobType: 'hourly', at: today, opportunityId: 'lab', monetaryValue: 9200 }],
      health: { pendingGhlScheduleSyncs: 2, makeRuns30d: [{ ok: 113, bad: 3 }] } },
    ledger: { bills: [{ payments: [{ amount: 87000, date: salesDay }] }] },
    ghl: [{ id: 'con', status: 'won', value: 5400, at: today }],
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
  const tasks = {
    estimating: source(() => exportFeed(env, 'ESTIMATING', ['opportunities', 'pipelines'], signal)),
    dispatch: source(() => exportFeed(env, 'DISPATCH', ['jobs', 'bookings'], signal)),
    ledger: source(() => exportFeed(env, 'LEDGER', ['bills'], signal)),
    ghl: source(() => containerSales(env, signal)),
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
  const { estimating, dispatch, ledger, ghl, twilio, make, builds } = sources;
  const demonstration = env.DATA_MODE === 'sample';
  const config = demonstration ? {
    CASH_ON_HAND_USD: '82000', CASH_AS_OF: today, MONTHLY_CASH_BURN_USD: '29000',
    MAKE_CYCLE_START: today, MAKE_CYCLE_CREDITS: '5500', NETLIFY_CREDITS_REMAINING: '232', NETLIFY_CREDITS_AS_OF: today,
  } : env;
  const netlifyBalance = number(config.NETLIFY_CREDITS_REMAINING);
  const netlifyDate = day(config.NETLIFY_CREDITS_AS_OF);
  const status = ({ status, detail }) => ({ status, detail });
  return {
    mode: demonstration ? 'sample' : 'live',
    range,
    generatedAt: now.toISOString(),
    kpis: {
      funnel: estimating.data ? funnel(estimating.data, range) : null,
      labor: dispatch.data ? laborSales(dispatch.data, range) : null,
      containers: ghl.data ? summarizeContainers(ghl.data, range) : null,
      workforce: dispatch.data ? workforce(dispatch.data, today) : null,
      runway: runway(ledger.data, config, today),
    },
    system: {
      sources: Object.fromEntries(Object.entries({ estimating, dispatch, ledger, ghl, twilio, make }).map(([name, state]) => [name, status(state)])),
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
      workforce: 'Unique workers assigned to active jobs scheduled today, excluding workers marked sent home.',
      runway: 'Cash on hand divided by monthly cash burn. The Ledger estimate covers recorded bill payments only.',
    },
  };
}
