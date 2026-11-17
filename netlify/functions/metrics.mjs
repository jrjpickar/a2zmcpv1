import { dashboardAccess } from './lib/dashboard-auth.mjs';
import { json } from './lib/http.mjs';
import { report } from './lib/report.mjs';
import { evaluate, loadSettings } from './lib/alerts.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });
  const access = dashboardAccess(request);
  if (!access && process.env.DATA_MODE !== 'sample') {
    return json({ error: 'Dashboard key required' }, 401);
  }
  try {
    const result = await report(Object.fromEntries(new URL(request.url).searchParams));
    // Triggered alerts ride along so the page needs one request per refresh. Sources are already cached, so this adds no upstream reads.
    const alerts = await loadSettings().then(settings => evaluate(settings)).then(r => r.alerts).catch(() => null);
    return json({ ...result, access: { mailbox: access?.mailbox ?? true, admin: access?.admin ?? false }, alerts: alerts && alerts.map(({ id, metric, district, message, severity }) => ({ id, metric, district, message, severity })) });
  } catch (error) {
    return error instanceof RangeError ? json({ error: error.message }, 400) : json({ error: 'Report unavailable' }, 500);
  }
};
export const config = { path: '/api/metrics' };
