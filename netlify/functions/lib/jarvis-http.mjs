// Request guards shared by the JARVIS endpoints. Reuses the dashboard access check (x-a2z-key with DASHBOARD_KEY,
// or a HighLevel session) and requires admin. POST also needs a same-origin Origin header and a JSON body.
import { dashboardAccess } from './dashboard-auth.mjs';
import { json } from './http.mjs';

export function guard(request, { env = process.env, methods = ['POST'] } = {}) {
  if (!methods.includes(request.method)) return { response: json({ error: 'Method not allowed.' }, 405, { Allow: methods.join(', ') }) };
  const access = dashboardAccess(request, env);
  if (!access) return { response: json({ error: 'Dashboard key required' }, 401) };
  if (!access.admin) return { response: json({ error: 'Administrator access required.' }, 403) };
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== new URL(request.url).origin) return { response: json({ error: 'Origin rejected.' }, 403) };
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return { response: json({ error: 'Expected JSON.' }, 415) };
  }
  return { access };
}

export async function readBody(request, limit) {
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) throw Object.assign(new Error('Request body exceeds the size limit.'), { status: 413 });
  const body = JSON.parse(text || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Expected a JSON object.');
  return body;
}
