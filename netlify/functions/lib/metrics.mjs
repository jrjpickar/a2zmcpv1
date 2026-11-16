import { number } from './http.mjs';

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

export function workforce(data, today) {
  const jobIds = new Set();
  const people = new Set();
  const identity = person => person?.id || person?.contactId || (person?.phone || '').replace(/\D/g, '').slice(-10)
    || person?.name?.trim().toLowerCase();
  for (const job of data.jobs) {
    if (!job.active || !job.reportDate || job.reportDate > today || (job.reportEndDate || job.reportDate) < today) continue;
    const sentHome = new Set((job.sentHome || []).filter(p => !p.reportDate || p.reportDate === today).map(identity).filter(Boolean));
    for (const worker of job.crew || []) {
      const id = identity(worker);
      if (!id || sentHome.has(id) || worker.sentHome === true) continue;
      people.add(id);
      jobIds.add(job.jobId);
    }
  }
  return { workers: people.size, jobs: jobIds.size, asOf: today };
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
