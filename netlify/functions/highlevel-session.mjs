import { createMarketplaceSession, decryptHighLevelContext, marketplaceIdentity } from './lib/dashboard-auth.mjs';
import { json } from './lib/http.mjs';

export default async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  const env = process.env;
  if (!env.GHL_APP_SHARED_SECRET || (env.GHL_SESSION_SECRET?.length || 0) < 32 ||
      !env.GHL_MARKETPLACE_COMPANY_ID || !env.GHL_LOCATION_ID || !env.GHL_MARKETPLACE_ALLOWED_USERS?.trim()) {
    return json({ error: 'HighLevel Marketplace sign-in is not configured.' }, 503);
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'HighLevel access denied.' }, 403);
  try {
    const body = await request.text();
    if (body.length > 14000) return json({ error: 'HighLevel access denied.' }, 403);
    const { encryptedData } = JSON.parse(body);
    if (typeof encryptedData !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedData)) throw new Error();
    const context = decryptHighLevelContext(encryptedData, env.GHL_APP_SHARED_SECRET);
    const identity = marketplaceIdentity(context, env);
    if (!identity) throw new Error();
    return json(createMarketplaceSession(identity, env));
  } catch {
    return json({ error: 'HighLevel access denied.' }, 403);
  }
};

export const config = { path: '/api/highlevel/session', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
