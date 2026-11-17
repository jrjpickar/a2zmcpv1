import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { json } from './lib/http.mjs';

const path = '/api/highlevel/install';
const cookie = '__Host-a2z-ghl-install';
const cookieOptions = '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=';
const installHosts = new Set(['marketplace.gohighlevel.com', 'marketplace.leadconnectorhq.com']);

function stateSignature(value, secret) {
  return createHmac('sha256', secret).update('a2z-ghl-install-v1.' + value).digest();
}

function validState(request, state, secret, now) {
  const saved = request.headers.get('cookie')?.split(/;\s*/)
    .find(value => value.startsWith(cookie + '='))?.slice(cookie.length + 1);
  const match = /^(\d{10})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(saved || '');
  if (!match || match[2] !== state || Number(match[1]) <= now) return false;
  return timingSafeEqual(Buffer.from(match[3], 'hex'), stateSignature(match[1] + '.' + match[2], secret));
}

export default async (request, { fetchImpl = fetch, store } = {}) => {
  if (request.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });
  const env = process.env;
  const requestUrl = new URL(request.url);
  const redirectUri = requestUrl.origin + path;
  let installUrl;
  try {
    installUrl = new URL(env.GHL_MARKETPLACE_INSTALL_URL);
    if (requestUrl.protocol !== 'https:' || installUrl.protocol !== 'https:' ||
        !installHosts.has(installUrl.hostname) || installUrl.port || installUrl.username || installUrl.password ||
        !['/oauth/chooselocation', '/v2/oauth/chooselocation'].includes(installUrl.pathname.toLowerCase()) ||
        installUrl.searchParams.get('redirect_uri') !== redirectUri ||
        !env.GHL_MARKETPLACE_CLIENT_ID || !env.GHL_MARKETPLACE_CLIENT_SECRET ||
        !env.GHL_MARKETPLACE_COMPANY_ID || !env.GHL_LOCATION_ID || (env.GHL_SESSION_SECRET?.length || 0) < 32) throw new Error();
  } catch {
    return json({ error: 'HighLevel installation is not configured for this domain.' }, 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const query = requestUrl.searchParams;
  const code = query.get('code');
  const state = query.get('state');
  if (!query.has('code') && !query.has('state') && !query.has('error')) {
    const nonce = randomBytes(32).toString('hex');
    const value = now + 600 + '.' + nonce;
    installUrl.searchParams.set('state', nonce);
    return new Response(null, { status: 302, headers: {
      Location: installUrl.toString(), 'Cache-Control': 'no-store',
      'Set-Cookie': cookie + '=' + value + '.' + stateSignature(value, env.GHL_SESSION_SECRET).toString('hex') + cookieOptions + '600',
    } });
  }

  const cleared = { 'Set-Cookie': cookie + '=' + cookieOptions + '0' };
  if (!code || code.length > 2048 || !validState(request, state, env.GHL_SESSION_SECRET, now)) {
    return json({ error: 'Start the HighLevel installation again from the Operations install URL.' }, 400, cleared);
  }
  try {
    const stateKey = createHash('sha256').update(state).digest('hex');
    const installStore = store || getStore({ name: 'a2z-highlevel-installs', consistency: 'strong' });
    const consumed = await installStore.setJSON(stateKey, { usedAt: now }, { onlyIfNew: true });
    if (!consumed.modified) return json({ error: 'This install attempt has already been used.' }, 400, cleared);
    const response = await fetchImpl('https://services.leadconnectorhq.com/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GHL_MARKETPLACE_CLIENT_ID, client_secret: env.GHL_MARKETPLACE_CLIENT_SECRET,
        grant_type: 'authorization_code', user_type: 'Location', code, redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) throw new Error();
    const installation = await response.json();
    if (!installation.access_token || installation.companyId !== env.GHL_MARKETPLACE_COMPANY_ID ||
        installation.locationId !== env.GHL_LOCATION_ID) {
      return json({ error: 'Install A2Z Operations in the configured HighLevel sub-account.' }, 403, cleared);
    }
    return new Response('Installation verified. Open A2Z Operations in the HighLevel sub-account menu.', {
      headers: { ...cleared, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return json({ error: 'HighLevel could not complete this installation. Start a new install attempt.' }, 502, cleared);
  }
};

export const config = { path: '/api/highlevel/install', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
