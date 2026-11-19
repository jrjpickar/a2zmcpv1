import { guard, readBody } from './lib/jarvis-http.mjs';
import { json } from './lib/http.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';

const key = 'mail/summary-filters';
const list = value => (value || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
const configDefaults = env => ({
  allowlist: list(env.MAIL_SUMMARY_ALLOWLIST),
  blocklist: list(env.MAIL_SUMMARY_BLOCKLIST),
});

export async function loadMailFilters(openStore = openJarvisStore, env = process.env) {
  const stored = await (await openStore()).getWithMetadata(key, { type: 'json' });
  return stored?.data ?? configDefaults(env);
}

export default async function mailFilters(request, { openStore = openJarvisStore } = {}) {
  const { response } = guard(request, { methods: ['GET', 'PUT'] });
  if (response) return response;
  if (request.method === 'GET') {
    try { return json(await loadMailFilters(openStore)); }
    catch { return json({ error: 'Mail filter settings are unavailable.' }, 503); }
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
  let filters;
  try {
    const body = await readBody(request, 12000);
    filters = {};
    for (const name of ['allowlist', 'blocklist']) {
      const entries = body[name];
      if (!Array.isArray(entries) || entries.length > 50 || entries.some(entry =>
        typeof entry !== 'string' || entry.length > 160 || !/^(?:[^\s,@]+)?@[a-z0-9.-]+$/i.test(entry.trim()))) {
        return json({ error: 'Use up to 50 email addresses or @domains per list.' }, 400);
      }
      filters[name] = [...new Set(entries.map(entry => entry.trim().toLowerCase()))];
    }
  } catch (error) {
    return json({ error: 'Invalid mail filter settings.' }, error.status || 400);
  }
  try {
    await (await openStore()).setJSON(key, filters, {});
    return json(filters);
  } catch {
    return json({ error: 'Mail filters could not be saved.' }, 503);
  }
}
export const config = { path: '/api/mail-filters' };
