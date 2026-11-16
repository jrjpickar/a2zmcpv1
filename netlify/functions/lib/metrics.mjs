import { createHash } from 'node:crypto';
import { number } from './http.mjs';

// Stable, non-reversible worker key so the page can follow one person between refreshes.
const workerKey = id => createHash('sha256').update(String(id)).digest('base64url').slice(0, 10);

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function day(value) {
  if (!value) return '';
  if (datePattern.test(value)) return date(new Date(value + 'T00:00:00Z')) === value ? value : '';
  const instant = new Date(value);
  return Number.isFinite(+instant) ? pacific.format(instant) : '';
}
const date = value => Number.isFinite(+value) ? value.toISOString().slice(0, 10) : '';
const shift = (value, days) => date(new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000));

export function rangeFor(input, now = new Date()) {
  const today = day(now);
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const starts = {
    today, wtd: shift(today, -(weekday + 6) % 7), mtd: today.slice(0, 7) + '-01',
    '30d': shift(today, -29), ytd: today.slice(0, 4) + '-01-01',
  };
  if (input.from !== undefined || input.to !== undefined) {
    if (!datePattern.test(input.from) || !datePattern.test(input.to) || day(input.from) !== input.from ||
        day(input.to) !== input.to || input.from > input.to || input.to > today) throw new RangeError('Invalid Pacific date range');
    return { from: input.from, to: input.to };
  }
  const preset = input.preset ?? 'mtd';
  if (!Object.hasOwn(starts, preset)) throw new RangeError('Invalid date preset');
  return { from: starts[preset], to: today };
}

function within(value, range) {
  const key = day(value);
  return key >= range.from && key <= range.to;
}

function unique(rows, key) {
  return [...new Map(rows.filter(row => row[key]).map(row => [row[key], row])).values()];
}

export function funnel(data, range) {
  const stages = new Map(data.pipelines.flatMap(p => p.stages.map(s => [p.id + ':' + s.id, s.name.toLowerCase().trim()])));
  const stage = row => stages.get(row.pipelineId + ':' + row.stageId);
  const rows = unique(data.opportunities, 'id');
  const dates = { proposal: new Map(), award: new Map() };
  const remember = (type, id, value) => {
    const at = day(value);
    if (!at) return;
    const previous = dates[type].get(id);
    if (!previous || at < previous) dates[type].set(id, at);
  };
  for (const event of data.history?.events || []) {
    if (Object.hasOwn(dates, event.type)) remember(event.type, event.id, event.at);
  }
  for (const row of rows) {
    if (stage(row) === 'proposal sent') remember('proposal', row.id, row.stageAt);
    if (row.pipelineId !== data.mainPipelineId) continue;
    const won = row.status?.toLowerCase() === 'won';
    if (won) remember('award', row.id, row.statusAt);
    if (stage(row) === 'job awarded' && (won || row.status?.toLowerCase() === 'open')) {
      remember('award', row.id, row.stageAt);
    }
  }
  const count = items => [...items.values()].filter(at => within(at, range)).length;
  return {
    leads: rows.filter(r => r.pipelineId === data.mainPipelineId && within(r.createdAt, range)).length,
    proposals: count(dates.proposal),
    wins: count(dates.award),
    eventHistory: data.history?.status || 'disabled',
  };
}

function sales(rows, field) {
  const values = rows.map(r => number(r[field]));
  return {
    count: rows.length, amount: Math.round(values.reduce((total, value) => total + (value ?? 0), 0) * 100) / 100,
    missingValue: values.filter(v => v === null).length,
  };
}

export const laborSales = (data, range) => sales(unique(data.bookings.filter(r =>
  r.kind === 'job' && (!r.jobType || r.jobType === 'hourly')), 'opportunityId').filter(r => within(r.at, range)), 'monetaryValue');

export const containerSales = (rows, range) => ({
  ...sales(rows.filter(r => r.status?.toLowerCase() === 'won' && within(r.at, range)), 'value'),
  missingDate: rows.filter(r => r.status?.toLowerCase() === 'won' && !day(r.at)).length,
});

// Bid-only pipelines are left out of sales: Multiple GCs Bidding by name, plus any IDs in `exclude`.
export const excludedPipeline = (p, exclude = []) => exclude.includes(p.id) || /multiple\s+gcs?\b/i.test(p.name || '');

export function pipelineSales(data, range, containerId, exclude = []) {
  const skip = new Set((data.pipelines || []).filter(p => excludedPipeline(p, exclude)).map(p => p.id).concat(exclude));
  const names = new Map((data.pipelines || []).filter(p => !skip.has(p.id)).map(p => [p.id, p.name]));
  const groups = new Map([...names.keys()].map(id => [id, []]));
  for (const row of data.opportunities) {
    if (skip.has(row.pipelineId)) continue;
    const id = row.pipelineId || 'unassigned';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const JOBS = 200;
  return [...groups].map(([id, rows]) => {
    // Won opportunities in range, highest value first. Missing values sort last.
    const jobs = rows.filter(r => r.status?.toLowerCase() === 'won' && within(r.at, range))
      .map(r => ({ id: r.id, name: r.name || 'Untitled opportunity', value: number(r.value), at: day(r.at) }))
      .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.name.localeCompare(b.name));
    return {
      id, name: names.get(id) || (id === containerId ? 'Containers' : id === 'unassigned' ? 'No pipeline' : 'Pipeline ' + id.slice(0, 6)),
      ...containerSales(rows, range), jobs: jobs.slice(0, JOBS), jobsMore: Math.max(0, jobs.length - JOBS),
    };
  }).sort((a, b) => b.amount - a.amount || b.count - a.count || a.name.localeCompare(b.name));
}

export function workforce(data, today) {
  const jobIds = new Set();
  const people = new Map();
  const identity = person => person?.id || person?.contactId || (person?.phone || '').replace(/\D/g, '').slice(-10)
    || person?.name?.trim().toLowerCase();
  for (const job of data.jobs) {
    if (!job.active || !job.reportDate || job.reportDate > today || (job.reportEndDate || job.reportDate) < today) continue;
    const sentHome = new Set((job.sentHome || []).filter(p => !p.reportDate || p.reportDate === today).map(identity).filter(Boolean));
    for (const worker of job.crew || []) {
      const id = identity(worker);
      if (!id || sentHome.has(id) || worker.sentHome === true) continue;
      if (!people.has(id)) people.set(id, {
        key: workerKey(id),
        name: String(worker.name || '').trim() || 'Crew member ' + (people.size + 1),
        role: String(worker.role || worker.title || '').trim() || null,
        job: String(job.jobName || job.name || job.title || job.customerName || '').trim() || 'Job ' + job.jobId,
      });
      jobIds.add(job.jobId);
    }
  }
  // Available: Dispatch roster members who are active and not booked on a job today.
  const roster = Array.isArray(data.workers) ? data.workers : null;
  const bench = new Map();
  for (const person of roster || []) {
    const id = identity(person);
    if (!id || people.has(id) || bench.has(id) || person.active === false || person.available === false) continue;
    bench.set(id, { key: workerKey(id), name: String(person.name || '').trim() || 'Crew member ' + (people.size + bench.size + 1), role: String(person.role || person.title || '').trim() || null });
  }
  return { workers: people.size, booked: people.size, available: roster ? bench.size : null, jobs: jobIds.size, asOf: today,
    crew: [...people.values()], bench: [...bench.values()] };
}

export function runway(ledger, cashFeed, env, today) {
  const cash = number(cashFeed?.balance);
  const verified = number(env.MONTHLY_CASH_BURN_USD);
  const asOf = day(cashFeed?.asOf);
  const observedRange = { from: shift(today, -90), to: shift(today, -1) };
  const observed = ledger?.bills
    .flatMap(bill => bill.payments || [])
    .filter(payment => within(payment.date, observedRange))
    .map(payment => number(payment.amount) ?? 0);
  const observedTotal = observed?.length ? observed.reduce((a, b) => a + b, 0) : null;
  const monthlyBurn = verified !== null && verified > 0 ? verified : observedTotal > 0 ? observedTotal / 3 : null;
  return {
    cash: asOf && asOf <= today && cash !== null ? cash : null,
    asOf: asOf && asOf <= today ? cashFeed.asOf : null,
    monthlyBurn,
    basis: verified > 0 ? 'Verified monthly burn input' : 'Ledger bill payments over the previous 90 days ÷ 3',
    estimated: !(verified > 0),
    months: asOf && asOf <= today && cash !== null && monthlyBurn ? Math.max(cash, 0) / monthlyBurn : null,
  };
}

export function makeCreditBalance(rows, env, today) {
  const start = day(env.MAKE_CYCLE_START);
  const total = number(env.MAKE_CYCLE_CREDITS);
  const captured = number(env.MAKE_CREDITS_REMAINING);
  const capturedAt = day(env.MAKE_CREDITS_AS_OF);
  const usage30d = rows ? rows.reduce((sum, row) => sum + row.credits, 0) : null;
  // Make exposes up to 30 days. Do not extrapolate a longer billing cycle.
  if (rows && start >= shift(today, -28) && start <= today && total !== null && total >= 0) {
    const used = rows.filter(r => r.date >= start).reduce((sum, r) => sum + r.credits, 0);
    return { balance: Math.max(0, total - used), basis: 'Estimated from current cycle allowance and Make usage', asOf: today, usage30d };
  }
  return {
    balance: capturedAt && capturedAt <= today && captured >= 0 ? captured : null,
    basis: 'Manual billing snapshot', asOf: capturedAt && capturedAt <= today ? capturedAt : null, usage30d,
  };
}

// Short, rule-based signals for the HQ overview and the model. tone: good, watch, act.
export function signals(k, s) {
  const out = [];
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  const add = (tone, area, text) => out.push({ tone, area, text });
  const r = k.runway;
  if (r?.months != null) add(r.months < 1.5 ? 'act' : r.months < 3 ? 'watch' : 'good', 'runway', r.months.toFixed(1) + ' months of runway on ' + usd(r.cash) + ' cash');
  const f = k.funnel;
  if (f) {
    const rate = f.proposals ? f.wins / f.proposals : null;
    add(rate == null ? 'watch' : rate < 0.2 ? 'watch' : 'good', 'wins', f.leads + ' leads, ' + f.proposals + ' proposals, ' + f.wins + ' wins' + (rate == null ? '' : ' (' + Math.round(rate * 100) + '% win rate)'));
  }
  const p = k.pipelines;
  if (p) {
    const total = p.reduce((t, x) => t + x.amount, 0), top = p[0];
    const missing = p.reduce((t, x) => t + x.missingValue, 0);
    add(total ? 'good' : 'watch', 'pipelines', usd(total) + ' won' + (top?.amount ? ', led by ' + top.name + ' ' + Math.round(top.amount / total * 100) + '%' : ''));
    if (missing) add('watch', 'pipelines', missing + ' won deal' + (missing === 1 ? '' : 's') + ' missing a dollar value');
  }
  if (k.labor) add(k.labor.count ? 'good' : 'watch', 'labor', usd(k.labor.amount) + ' labor booked across ' + k.labor.count + ' booking' + (k.labor.count === 1 ? '' : 's'));
  const w = k.workforce;
  if (w) {
    const pool = w.available == null ? null : w.booked + w.available;
    add(pool && w.booked / pool < 0.6 ? 'watch' : 'good', 'workforce', w.booked + ' crew booked on ' + w.jobs + ' job' + (w.jobs === 1 ? '' : 's') +
      (pool ? ', ' + w.available + ' available (' + Math.round(w.booked / pool * 100) + '% utilized)' : ''));
  }
  const down = Object.entries(s.sources).filter(([, x]) => x.status === 'error').map(([n]) => n);
  const setup = Object.entries(s.sources).filter(([, x]) => x.status === 'setup').map(([n]) => n);
  const deploys = Object.entries(s.deploys).filter(([, d]) => d.status === 'ok' && d.state !== 'ready').map(([n]) => n);
  if (down.length || deploys.length) add('act', 'system', [down.length && down.join(', ') + ' feed down', deploys.length && deploys.join(', ') + ' deploy not ready'].filter(Boolean).join('; '));
  else add(setup.length ? 'watch' : 'good', 'system', setup.length ? setup.length + ' feed' + (setup.length === 1 ? '' : 's') + ' still need setup' : 'All feeds connected and deploys live');
  if (s.twilio?.balance != null && s.twilio.balance < 20) add('act', 'system', 'Twilio balance low at $' + s.twilio.balance.toFixed(2));
  if (s.dispatch?.makeRuns30d?.bad) add('watch', 'system', s.dispatch.makeRuns30d.bad + ' Dispatch Make runs to review');
  const rank = { act: 0, watch: 1, good: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
