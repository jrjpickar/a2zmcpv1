// Alert rules on every dashboard metric. Settings and send state live in Netlify Blobs.
// A matching rule posts one JSON payload to the configured webhook (Make by default), then waits out its cooldown.
import { appStore, SETTINGS_KEY } from './store.mjs';
import { report as buildReport } from './report.mjs';

export const DEFAULT_WEBHOOK = 'https://hook.us2.make.com/bjl5ooam64m8csp4glmr3bxbykc9cpi5';
export const PRESETS = ['today', 'wtd', 'mtd', '30d', 'ytd'];
const STATE_KEY = 'alerts/state', RUN_KEY = 'alerts/lastRun';
const usd = v => v == null ? 'n/a' : '$' + Math.round(v).toLocaleString('en-US');
const count = v => v == null ? 'n/a' : Math.round(v * 10) / 10 + '';

// Every alertable metric. kind: number (above/below) or status (not ok). period: depends on the date range.
export function catalog(report) {
  const k = report.kpis, s = report.system;
  const list = [
    { key: 'leads', group: 'Sales', label: 'New leads', district: 'leads', period: true, value: k.funnel?.leads, format: count },
    { key: 'proposals', group: 'Sales', label: 'Proposals sent', district: 'proposals', period: true, value: k.funnel?.proposals, format: count },
    { key: 'wins', group: 'Sales', label: 'Jobs won', district: 'wins', period: true, value: k.funnel?.wins, format: count },
    { key: 'labor', group: 'Sales', label: 'Labor sales', district: 'labor', period: true, value: k.labor?.amount, format: usd },
    { key: 'labor-count', group: 'Sales', label: 'Labor jobs won', district: 'labor', period: true, value: k.labor?.count, format: count },
    { key: 'pipeline-total', group: 'Sales', label: 'Pipeline sales, all pipelines', district: 'pipelines', period: true,
      value: k.pipelines ? k.pipelines.reduce((t, p) => t + p.amount, 0) : null, format: usd },
    ...(k.pipelines || []).filter(p => p.id !== 'unassigned').map(p => ({ key: 'pipeline:' + p.id, group: 'Sales', label: 'Pipeline sales, ' + p.name,
      district: 'pipelines', period: true, value: p.amount, format: usd })),
    { key: 'workforce', group: 'Operations', label: 'Booked crew', district: 'workforce', value: k.workforce?.workers, format: count },
    { key: 'workforce-available', group: 'Operations', label: 'Available crew', district: 'workforce', value: k.workforce?.available, format: count },
    { key: 'workforce-jobs', group: 'Operations', label: 'Active jobs with crew', district: 'workforce', value: k.workforce?.jobs, format: count },
    { key: 'pending-syncs', group: 'Operations', label: 'Pending Dispatch syncs', district: 'system', value: s.dispatch?.pendingSyncs, format: count },
    { key: 'make-runs', group: 'Operations', label: 'Dispatch Make runs to review', district: 'system', value: s.dispatch?.makeRuns30d?.bad, format: count },
    { key: 'runway', group: 'Finance', label: 'Financial runway (months)', district: 'runway', value: k.runway?.months, format: count },
    { key: 'cash', group: 'Finance', label: 'Cash on hand', district: 'runway', value: k.runway?.cash, format: usd },
    { key: 'burn', group: 'Finance', label: 'Monthly cash burn', district: 'runway', value: k.runway?.monthlyBurn, format: usd },
    { key: 'twilio', group: 'Accounts', label: 'Twilio balance', district: 'system', value: s.twilio?.balance, format: v => v == null ? 'n/a' : '$' + v.toFixed(2) },
    { key: 'make-credits', group: 'Accounts', label: 'Make credits remaining', district: 'system', value: s.make?.balance, format: count },
    { key: 'netlify-credits', group: 'Accounts', label: 'Netlify credits remaining', district: 'system', value: s.netlify?.balance, format: count },
    ...Object.entries(s.deploys).map(([name, d]) => ({ key: 'deploy:' + name, group: 'Systems', label: name + ' deploy', district: 'system', kind: 'status',
      ok: d.state === 'ready', value: d.state || d.status })),
    ...Object.entries(s.sources).map(([name, src]) => ({ key: 'source:' + name, group: 'Systems', label: sourceNames[name] || name, district: 'system', kind: 'status',
      ok: src.status === 'ok', value: src.status === 'ok' ? 'connected' : src.status === 'setup' ? 'setup needed' : 'unavailable' })),
  ];
  return list.map(m => ({ kind: 'number', period: false, ...m }));
}
const sourceNames = { estimating: 'Estimating feed', dispatch: 'Dispatch feed', ledger: 'Ledger feed', cash: 'Cash balance feed', ghl: 'GoHighLevel', twilio: 'Twilio API', make: 'Make API' };

export function defaults() {
  return { webhookUrl: DEFAULT_WEBHOOK, enabled: true, cooldownMinutes: 240, rules: {}, billing: {} };
}

// Accept only known fields. Rules: { [metricKey]: { enabled, op: above|below|not_ok, threshold, preset } }
export function sanitize(input) {
  const out = defaults();
  if (!input || typeof input !== 'object') throw new RangeError('Invalid settings');
  const url = String(input.webhookUrl ?? out.webhookUrl).trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new RangeError('Webhook URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new RangeError('Webhook URL must use https');
  out.webhookUrl = parsed.href;
  out.enabled = input.enabled !== false;
  const cooldown = Number(input.cooldownMinutes ?? out.cooldownMinutes);
  if (!Number.isFinite(cooldown) || cooldown < 15 || cooldown > 10080) throw new RangeError('Cooldown must be 15 to 10080 minutes');
  out.cooldownMinutes = Math.round(cooldown);
  // Billing inputs Netlify and Make do not expose by API. Blank fields are dropped.
  const b = input.billing && typeof input.billing === 'object' ? input.billing : {};
  const num = (k, max) => { if (b[k] === '' || b[k] == null) return; const v = Number(b[k]); if (!Number.isFinite(v) || v < 0 || v > max) throw new RangeError('Invalid ' + k); out.billing[k] = v; };
  const date = k => { if (!b[k]) return; if (!/^\d{4}-\d{2}-\d{2}$/.test(b[k])) throw new RangeError(k + ' must be YYYY-MM-DD'); out.billing[k] = b[k]; };
  num('netlifyCreditsRemaining', 1e9); date('netlifyCreditsAsOf'); num('netlifyMonthlyCredits', 1e9); num('makeCycleCredits', 1e10);
  if (out.billing.netlifyCreditsRemaining != null && !out.billing.netlifyCreditsAsOf) throw new RangeError('Add the date the Netlify credits were read');
  const rules = input.rules && typeof input.rules === 'object' ? input.rules : {};
  if (Object.keys(rules).length > 200) throw new RangeError('Too many rules');
  for (const [key, rule] of Object.entries(rules)) {
    if (!/^[\w:.-]{1,80}$/.test(key) || !rule || typeof rule !== 'object') throw new RangeError('Invalid rule ' + key);
    const op = ['above', 'below', 'not_ok'].includes(rule.op) ? rule.op : null;
    if (!op) throw new RangeError('Invalid condition for ' + key);
    const threshold = op === 'not_ok' ? null : Number(rule.threshold);
    if (op !== 'not_ok' && (rule.threshold === '' || rule.threshold == null || !Number.isFinite(threshold))) throw new RangeError('Threshold required for ' + key);
    const preset = PRESETS.includes(rule.preset) ? rule.preset : 'mtd';
    out.rules[key] = { enabled: rule.enabled === true, op, threshold, preset };
  }
  return out;
}

export const alertStore = appStore;
export async function loadSettings(store = alertStore()) {
  const saved = await store.get(SETTINGS_KEY, { type: 'json' }).catch(() => null);
  return saved ? { ...defaults(), ...saved, rules: saved.rules || {}, billing: saved.billing || {} } : defaults();
}
export async function saveSettings(input, store = alertStore()) {
  const clean = sanitize(input);
  await store.setJSON(SETTINGS_KEY, clean);
  return clean;
}

const describe = (m, rule) => rule.op === 'not_ok' ? 'is not healthy' : (rule.op === 'below' ? 'below ' : 'above ') + m.format(rule.threshold);

// Evaluate enabled rules. One report per date range used. Metrics with no data never trigger number rules.
export async function evaluate(settings, { env = process.env, now = new Date(), reportImpl = buildReport } = {}) {
  const enabled = Object.entries(settings.rules).filter(([, r]) => r.enabled);
  const presets = [...new Set(enabled.map(([key, r]) => r.preset))];
  if (!presets.length) presets.push('mtd');
  const reports = Object.fromEntries(await Promise.all(presets.map(async p => [p, await reportImpl({ preset: p }, env, now)])));
  const byPreset = Object.fromEntries(Object.entries(reports).map(([p, r]) => [p, new Map(catalog(r).map(m => [m.key, m]))]));
  const alerts = [];
  for (const [key, rule] of enabled) {
    const m = byPreset[rule.preset]?.get(key) ?? byPreset[presets[0]].get(key);
    if (!m) continue;
    const hit = rule.op === 'not_ok' ? m.kind === 'status' && !m.ok
      : m.kind === 'number' && m.value != null && (rule.op === 'below' ? m.value < rule.threshold : m.value > rule.threshold);
    if (!hit) continue;
    const range = reports[rule.preset]?.range;
    alerts.push({
      id: key, metric: m.label, group: m.group, district: m.district, condition: rule.op, threshold: rule.threshold,
      value: m.value, valueText: m.kind === 'status' ? m.value : m.format(m.value),
      period: m.period ? rule.preset : null, range: m.period ? range : null,
      severity: m.kind === 'status' || rule.op === 'below' ? 'high' : 'medium',
      message: m.label + ' ' + describe(m, rule) + ': now ' + (m.kind === 'status' ? m.value : m.format(m.value)) + (m.period ? ' (' + range.from + ' to ' + range.to + ')' : ''),
    });
  }
  return { alerts, mode: reports[presets[0]].mode, metrics: catalog(reports.mtd || reports[presets[0]]) };
}

export function payload(alerts, { mode, test = false, now = new Date(), env = process.env } = {}) {
  return {
    source: 'a2z-operations', event: test ? 'alert.test' : 'alert.triggered', test, mode,
    sentAt: now.toISOString(), dashboardUrl: env.URL || null, count: alerts.length,
    summary: alerts.map(a => a.message).join('\n'), alerts,
  };
}

export async function post(url, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Webhook HTTP ' + response.status);
}

// Scheduled and manual check. Sends each triggered rule once per cooldown. Never throws. The outcome is kept for Diagnostics.
export async function runCheck(options = {}) {
  const { now = new Date(), store = alertStore() } = options;
  const result = await check(options);
  await store.setJSON(RUN_KEY, { at: now.toISOString(), manual: Boolean(options.force), result }).catch(() => {});
  return result;
}
export async function lastRun(store = alertStore()) {
  return store.get(RUN_KEY, { type: 'json' }).catch(() => null);
}
async function check({ env = process.env, now = new Date(), store = alertStore(), fetchImpl = fetch, reportImpl, force = false } = {}) {
  try {
    const settings = await loadSettings(store);
    if (!settings.enabled) return { skipped: 'Alerts are turned off' };
    if (!Object.values(settings.rules).some(r => r.enabled)) return { skipped: 'No alert rules enabled' };
    if (env.DATA_MODE === 'sample' && env.ALERT_ALLOW_SAMPLE !== '1' && !force) return { skipped: 'Sample mode' };
    const { alerts, mode } = await evaluate(settings, { env, now, reportImpl });
    const state = (await store.get(STATE_KEY, { type: 'json' }).catch(() => null)) || { sent: {} };
    const wait = settings.cooldownMinutes * 60000, at = now.getTime();
    const fresh = alerts.filter(a => !state.sent[a.id] || at - state.sent[a.id] > wait);
    // Rules that recovered can alert again on their next breach.
    for (const id of Object.keys(state.sent)) if (!alerts.some(a => a.id === id)) delete state.sent[id];
    if (fresh.length) {
      await post(settings.webhookUrl, payload(fresh, { mode, now, env }), fetchImpl);
      for (const a of fresh) state.sent[a.id] = at;
    }
    await store.setJSON(STATE_KEY, state);
    return { triggered: alerts.length, sent: fresh.length };
  } catch (error) {
    console.error('Alert check failed', error);
    return { error: error instanceof RangeError ? error.message : 'Alert check failed' };
  }
}
