import { dashboardAccess } from './lib/dashboard-auth.mjs';
import { json } from './lib/http.mjs';

export default async function handler(request, { env = process.env, fetchImpl = fetch } = {}) {
  if (!dashboardAccess(request, env)?.admin) return json({ error: 'Admin access required' }, 403);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  const origin = request.headers.get('origin');
  if (request.method === 'POST' && origin && origin !== new URL(request.url).origin) {
    return json({ error: 'Origin rejected' }, 403);
  }
  if (!env.JOSE_RUNTIME_URL || (env.JOSE_TOKEN || '').length < 32) {
    return json({ error: 'JOSE runtime is not configured' }, 503);
  }
  try {
    const url = new URL(env.JOSE_RUNTIME_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/jose' ||
      url.search || url.hash) return json({ error: 'Invalid JOSE runtime URL' }, 503);
    const headers = { authorization: 'Bearer ' + env.JOSE_TOKEN, 'content-type': 'application/json' };
    if (env.JOSE_ACCESS_CLIENT_ID && env.JOSE_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.JOSE_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = env.JOSE_ACCESS_CLIENT_SECRET;
    }
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && Buffer.byteLength(body) > 16000) return json({ error: 'Payload too large' }, 413);
    const upstream = await fetchImpl(url, { method: request.method, headers, body,
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (upstream.status >= 500 || [401, 403].includes(upstream.status)) {
      await upstream.body?.cancel();
      return json({ error: 'JOSE runtime unavailable' }, 502);
    }
    return json(await upstream.json(), upstream.status);
  } catch { return json({ error: 'JOSE runtime unavailable' }, 502); }
}

export const config = { path: '/api/jose-runtime' };
