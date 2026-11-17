import { authorized, json } from './lib/http.mjs';
import { diagnostics } from './lib/report.mjs';
import { alertStore, lastRun, loadSettings } from './lib/alerts.mjs';

// GET /api/diagnostics[?fresh=1]. Needs the dashboard key. Shows status, timing and record counts, never secret values.
export default async (request, { store = alertStore(), fetchImpl = fetch } = {}) => {
  if (request.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });
  if (!authorized(request, process.env.DASHBOARD_KEY, 'x-a2z-key')) return json({ error: 'Dashboard key required' }, 401);
  try {
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    const result = await diagnostics({ fresh, fetchImpl });
    const t0 = Date.now();
    let blobs, settings = null, run = null;
    try {
      settings = await loadSettings(store);
      run = await lastRun(store);
      blobs = { status: 'ok', detail: 'Settings store reachable', ms: Date.now() - t0 };
    } catch { blobs = { status: 'error', detail: 'Netlify Blobs unreachable', ms: Date.now() - t0 }; }
    const rules = settings ? Object.values(settings.rules).filter(r => r.enabled).length : 0;
    const age = run ? (Date.now() - Date.parse(run.at)) / 60000 : null;
    const scheduler = !settings?.enabled || !rules ? { status: 'setup', detail: settings?.enabled === false ? 'Alerts are turned off' : 'No alert rules enabled' }
      : run?.result?.error ? { status: 'error', detail: run.result.error }
      : age == null ? { status: 'setup', detail: 'No check has run yet' }
      : age > 35 && !run.manual ? { status: 'error', detail: 'Last scheduled check ' + Math.round(age) + ' minutes ago' }
      : { status: 'ok', detail: run.result?.skipped || (run.result?.sent ? 'Sent ' + run.result.sent : 'Nothing new to send') + ', ' + (run.result?.triggered ?? 0) + ' triggered' };
    result.checks.push(
      { id: 'blobs', group: 'Services', label: 'Netlify Blobs (alert settings)', ...blobs, checkedAt: new Date().toISOString() },
      { id: 'alerts', group: 'Services', label: 'Alert scheduler (every 15 min)', ...scheduler, checkedAt: run?.at || null,
        records: { rulesEnabled: rules, webhook: settings ? new URL(settings.webhookUrl).host : null, cooldownMinutes: settings?.cooldownMinutes ?? null } },
    );
    return json(result);
  } catch (error) {
    console.error('Diagnostics failed', error);
    return json({ error: 'Diagnostics unavailable' }, 500);
  }
};
export const config = { path: '/api/diagnostics' };
