import { authorized, json } from './lib/http.mjs';
import { report } from './lib/report.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });
  if (process.env.DATA_MODE !== 'sample' && !authorized(request, process.env.DASHBOARD_KEY, 'x-a2z-key')) {
    return json({ error: 'Dashboard key required' }, 401);
  }
  try {
    return json(await report(Object.fromEntries(new URL(request.url).searchParams)));
  } catch (error) {
    return error instanceof RangeError ? json({ error: error.message }, 400) : json({ error: 'Report unavailable' }, 500);
  }
};
export const config = { path: '/api/metrics' };
