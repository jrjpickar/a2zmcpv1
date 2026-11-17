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


export const containerSales = (rows, range) => ({
  ...sales(rows.filter(r => r.status?.toLowerCase() === 'won' && within(r.at, range)), 'value'),
  missingDate: rows.filter(r => r.status?.toLowerCase() === 'won' && !day(r.at)).length,
});

// Non-sales pipelines are left out: Multiple GCs Bidding, Hiring and New Customer by name, plus any IDs or names in `exclude`.
const NON_SALES = /multiple\s+gcs?\b|hiring|new\s+customers?/i;
export const excludedPipeline = (p, exclude = []) => exclude.includes(p.id) || NON_SALES.test(p.name || '')
  || exclude.some(x => x.toLowerCase() === String(p.name || '').trim().toLowerCase());

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

const fullName = p => String(p?.name || p?.fullName || p?.contactName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || '').trim();
const jobLabel = j => String(j.jobName || j.name || j.title || j.customerName || j.customer?.name || j.siteName || j.address || '').trim();
// Dispatch rosters may arrive under different keys. The first array found is used.
const rosterOf = data => ['workers', 'roster', 'employees', 'crewMembers', 'laborers'].map(k => data[k]).find(Array.isArray) || null;

const jobDate = j => day(j.reportDate || j.date || j.scheduledDate || j.workDate || j.startDate || j.day);
const jobEnd = j => day(j.reportEndDate || j.endDate || j.untilDate);
const crewOf = j => ['crew', 'workers', 'assigned', 'assignedWorkers', 'laborers', 'team', 'employees'].map(k => j[k]).find(Array.isArray) || [];

// Jobs from the Dispatch board, whatever shape the export uses: a jobs list, a board list, a board keyed by date,
// or flat assignments (one row per worker per job per day).
export function boardJobs(data) {
  const jobs = [...(Array.isArray(data.jobs) ? data.jobs : [])];
  const board = data.board || data.dispatchBoard;
  if (Array.isArray(board)) jobs.push(...board);
  else if (board && typeof board === 'object') {
    if (Array.isArray(board.jobs)) jobs.push(...board.jobs);
    for (const [k, v] of Object.entries(board)) if (/^\d{4}-\d{2}-\d{2}/.test(k) && Array.isArray(v)) jobs.push(...v.map(j => ({ reportDate: k, ...j })));
  }
  const rows = ['assignments', 'dispatches', 'schedule', 'boardAssignments'].map(k => data[k]).find(Array.isArray);
  if (rows) {
    const grouped = new Map();
    for (const a of rows) {
      const d = day(a.date || a.reportDate || a.workDate || a.day), jobId = a.jobId || a.job?.id || a.opportunityId || 'job';
      const k = jobId + '|' + d;
      if (!grouped.has(k)) grouped.set(k, { jobId, name: a.jobName || a.job?.name || a.jobTitle, reportDate: d, active: a.active, status: a.status, crew: [] });
      grouped.get(k).crew.push(a.worker || { id: a.workerId || a.contactId, name: a.workerName || a.name, phone: a.phone, role: a.role, sentHome: a.sentHome });
    }
    jobs.push(...grouped.values());
  }
  // Deduplicate the same job and day across shapes.
  return [...new Map(jobs.map(j => [(j.jobId || j.id || j.opportunityId || Math.random()) + '|' + jobDate(j), { ...j, jobId: j.jobId || j.id || j.opportunityId }])).values()];
}

// Why each Dispatch job was or was not counted today. Field names only, no values, for Diagnostics.
export function workforceTrace(data, today) {
  const jobs = boardJobs(data), dates = jobs.map(jobDate).filter(Boolean).sort();
  const t = { jobs: jobs.length, today: 0, inactive: 0, noDate: 0, otherDay: 0, noCrew: 0, crewEntries: 0, datesSeen: dates.length ? dates[0] + ' to ' + dates.at(-1) : 'none' };
  for (const j of jobs) {
    const start = jobDate(j), end = jobEnd(j) || start, crew = crewOf(j);
    if (j.active === false || /^(cancel|complete|closed)/i.test(String(j.status || ''))) t.inactive++;
    else if (!start) t.noDate++;
    else if (start > today || end < today) t.otherDay++;
    else if (!crew.length) t.noCrew++;
    else { t.today++; t.crewEntries += crew.length; }
  }
  const keys = o => o && typeof o === 'object' ? Object.keys(o).slice(0, 30).join(', ') : 'none';
  const first = jobs[0];
  t.exportKeys = Object.entries(data).map(([k, v]) => k + (Array.isArray(v) ? '[' + v.length + ']' : v && typeof v === 'object' ? '{}' : '')).join(', ');
  t.jobFields = keys(first);
  t.crewFields = keys(first && crewOf(first)[0]);
  return t;
}

export function workforce(data, today) {
  const jobIds = new Set();
  const people = new Map();
  const identity = person => person?.id || person?.contactId || person?.workerId || (person?.phone || '').replace(/\D/g, '').slice(-10)
    || fullName(person).toLowerCase();
  for (const job of boardJobs(data)) {
    // Report dates may be plain dates or full timestamps. Compare them as Pacific dates.
    const start = jobDate(job), end = jobEnd(job) || start;
    if (job.active === false || String(job.status || '').toLowerCase().match(/^(cancel|complete|closed)/) || !start || start > today || end < today) continue;
    const sentHome = new Set((job.sentHome || []).filter(p => !p.reportDate || day(p.reportDate) === today).map(identity).filter(Boolean));
    for (const worker of crewOf(job)) {
      const id = identity(worker);
      if (!id || sentHome.has(id) || worker.sentHome === true) continue;
      if (!people.has(id)) people.set(id, {
        key: workerKey(id),
        name: fullName(worker) || 'Crew member ' + (people.size + 1),
        role: String(worker.role || worker.title || '').trim() || null,
        job: jobLabel(job) || 'Job ' + job.jobId,
      });
      jobIds.add(job.jobId);
    }
  }
// Available: Dispatch roster members who are active and not booked on a job today.
  const roster = rosterOf(data);
  const bench = new Map();
  for (const person of roster || []) {
    const id = identity(person);
    if (!id || people.has(id) || bench.has(id) || person.active === false || person.available === false
      || /^(inactive|terminated|archived)/i.test(String(person.status || ''))) continue;
    bench.set(id, { key: workerKey(id), name: fullName(person) || 'Crew member ' + (people.size + bench.size + 1), role: String(person.role || person.title || '').trim() || null });
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

// Make credits remaining, best source first: live organization allowance minus consumed, allowance minus usage since the
// last reset, the env cycle inputs, then a manual snapshot. data is { usage, org } (or a plain usage array).
export function makeCreditBalance(data, env, today, billing = {}) {
  const rows = Array.isArray(data) ? data : data?.usage || null, org = Array.isArray(data) ? null : data?.org || null;
  const usage30d = rows ? rows.reduce((sum, row) => sum + row.credits, 0) : null;
  const allowance = org?.allowance ?? number(billing.makeCycleCredits) ?? number(env.MAKE_CYCLE_CREDITS);
  const nextReset = day(org?.nextReset) || null;
  if (allowance !== null && org?.consumed != null) {
    return { balance: Math.max(0, allowance - org.consumed), allowance, used: org.consumed, basis: 'Live from Make organization', asOf: today, nextReset, usage30d };
  }
  const reset = day(org?.lastReset) || day(env.MAKE_CYCLE_START);
  // Make usage covers 30 days. Do not extrapolate a longer cycle.
  if (rows && allowance !== null && reset && reset >= shift(today, -28) && reset <= today) {
    const used = rows.filter(r => r.date >= reset).reduce((sum, r) => sum + r.credits, 0);
    return { balance: Math.max(0, allowance - used), allowance, used, basis: 'Allowance minus Make usage since ' + reset, asOf: today, nextReset, usage30d };
  }
  const captured = number(env.MAKE_CREDITS_REMAINING), capturedAt = day(env.MAKE_CREDITS_AS_OF);
  if (capturedAt && capturedAt <= today && captured >= 0) return { balance: captured, basis: 'Manual billing snapshot', asOf: capturedAt, nextReset, usage30d };
  return { balance: null, basis: allowance === null ? 'Make did not report the plan allowance. Enter credits per cycle in Alerts, Billing inputs' : 'Make did not report the last reset date',
    asOf: null, nextReset, usage30d };
}

// Netlify has no credit balance API. Uses the snapshot entered in Alerts, Billing inputs, then env.
export function netlifyCreditBalance(env, today, billing = {}) {
  const fromUi = billing.netlifyCreditsRemaining != null;
  const balance = fromUi ? number(billing.netlifyCreditsRemaining) : number(env.NETLIFY_CREDITS_REMAINING);
  const asOf = day(fromUi ? billing.netlifyCreditsAsOf : env.NETLIFY_CREDITS_AS_OF);
  if (balance === null || !asOf || asOf > today) return { balance: null, asOf: null, basis: 'Netlify has no credit API. Enter the balance in Alerts, Billing inputs' };
  const age = Math.round((Date.parse(today) - Date.parse(asOf)) / 86400000);
  return { balance, asOf, ageDays: age, monthly: number(billing.netlifyMonthlyCredits), basis: 'Snapshot from the Netlify billing page' + (age ? ', ' + age + ' day' + (age === 1 ? '' : 's') + ' old' : '') };
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
  if (k.labor) add(k.labor.count ? 'good' : 'watch', 'labor', usd(k.labor.amount) + ' labor won across ' + k.labor.count + ' job' + (k.labor.count === 1 ? '' : 's'));
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
