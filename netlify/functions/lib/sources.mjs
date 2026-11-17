import { ExposedError, MissingConfiguration, number, readJson, required } from './http.mjs';

export const siteKeys = { Estimating: 'ESTIMATING', Dispatch: 'DISPATCH', Ledger: 'LEDGER' };

// Every source result carries how long it took and when, for the Diagnostics tab.
export async function source(load) {
  const started = Date.now();
  const meta = () => ({ ms: Date.now() - started, checkedAt: new Date().toISOString() });
  try {
    return { status: 'ok', data: await load(), ...meta() };
  } catch (error) {
    if (error instanceof MissingConfiguration) return { status: 'setup', detail: error.message, ...meta() };
    if (error instanceof ExposedError) return { status: 'error', detail: error.message, ...meta() };
    const upstream = /^Upstream HTTP (\d+)$/.exec(error.message);
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { status: 'error', detail: upstream ? 'Upstream HTTP ' + upstream[1] : timeout ? 'Timed out' : 'Upstream unavailable or invalid response', ...meta() };
  }
}

export async function exportFeed(env, name, keys, signal) {
  const base = new URL(required(env, name + '_URL'));
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid feed URL');
  const key = required(env, name + '_EXPORT_KEY');
  const data = await readJson(new URL('/.netlify/functions/metrics-export', base), {
    headers: { 'x-metrics-key': key }, signal,
  });
  if (data?.version !== 1 || keys.some(k => !Array.isArray(data[k]))) throw new Error('Invalid export');
  return data;
}

export const containerPipelineId = env => env.CONTAINER_PIPELINE_ID || 'F8i8hB7E5xHrJbJUXFr4';

async function pipelineNames(location, headers, signal) {
  try {
    const data = await readJson('https://services.leadconnectorhq.com/opportunities/pipelines?locationId=' + encodeURIComponent(location), { headers, signal });
    return Array.isArray(data?.pipelines) ? data.pipelines.filter(p => p?.id).map(p => ({ id: p.id, name: String(p.name || '').trim() })) : [];
  } catch {
    return [];
  }
}

// Won opportunities across every pipeline in the location, with pipeline names.
export async function wonSales(env, signal) {
  const token = required(env, 'GHL_PIT_TOKEN');
  const location = env.GHL_LOCATION_ID || 'QUcu2PEAxPV1sQm1GQCq';
  const headers = { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' };
  const params = new URLSearchParams({ location_id: location, status: 'won', limit: '100' });
  const names = pipelineNames(location, headers, signal);
  const rows = new Map();
  const cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await readJson('https://services.leadconnectorhq.com/opportunities/search?' + params, { headers, signal });
    if (!Array.isArray(data?.opportunities) || data.opportunities.some(row => !row.id)) throw new Error('Invalid opportunities');
    for (const row of data.opportunities) rows.set(row.id, {
      id: row.id, name: String(row.name || row.contact?.name || '').trim() || null, pipelineId: row.pipelineId || null, status: row.status, at: row.lastStatusChangeAt, value: number(row.monetaryValue),
    });
    const { meta, opportunities } = data;
    if (rows.size === meta?.total || (opportunities.length < 100 && !Number.isFinite(meta?.total))) {
      return { pipelines: await names, opportunities: [...rows.values()] };
    }
    const cursor = meta?.startAfterId;
    if (!cursor || meta.startAfter == null || cursors.has(cursor)) throw new Error('Incomplete opportunity pagination');
    cursors.add(cursor);
    params.set('startAfterId', cursor);
    params.set('startAfter', String(meta.startAfter));
  }
  throw new Error('Opportunity pagination limit');
}

export async function twilioBalance(env) {
  const sid = required(env, 'TWILIO_ACCOUNT_SID');
  if (!/^AC[a-f0-9]{32}$/i.test(sid)) throw new Error('Invalid Twilio account ID');
  const secret = required(env, 'TWILIO_AUTH_TOKEN');
  const data = await readJson('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Balance.json', {
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + secret).toString('base64') },
  });
  const balance = number(data.balance);
  if (balance === null || !/^[A-Z]{3}$/.test(data.currency)) throw new Error('Invalid Twilio balance');
  return { balance, currency: data.currency, asOf: new Date().toISOString() };
}

export async function netlifyDeploy(env, key) {
  const id = required(env, key + '_NETLIFY_SITE_ID');
  const token = required(env, 'NETLIFY_ACCESS_TOKEN');
  const url = 'https://api.netlify.com/api/v1/sites/' + encodeURIComponent(id);
  const headers = { Authorization: 'Bearer ' + token };
  const [site, deploys] = await Promise.all([
    readJson(url, { headers }),
    readJson(url + '/deploys?production=true&per_page=10', { headers }),
  ]);
  if (!site.id || !Array.isArray(deploys)) throw new Error('Invalid Netlify deploy data');
  const published = site.published_deploy || deploys.find(d => d.id === site.deploy_id);
  const latest = deploys.find(d => d.context === 'production');
  return {
    state: published?.state || 'unknown',
    publishedAt: published?.published_at || published?.updated_at || null,
    latestState: latest?.state || null, latestAt: latest?.created_at || null,
  };
}

// Accepts "us2.make.com", "https://us2.make.com/" or ".../api/v2". Celonis zones are allowed too.
export function makeZone(raw) {
  const host = String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)?(?:eu|us)\d\.make\.(?:com|celonis\.com)$/.test(host)) throw new ExposedError('MAKE_ZONE must look like us2.make.com');
  return host;
}

export async function makeUsage(env) {
  const zone = makeZone(required(env, 'MAKE_ZONE'));
  const org = required(env, 'MAKE_ORG_ID');
  const token = required(env, 'MAKE_API_TOKEN').replace(/^Token\s+/i, '');
  if (!/^\d+$/.test(org)) throw new ExposedError('MAKE_ORG_ID must be the numeric organization ID');
  let data;
  try {
    data = await readJson('https://' + zone + '/api/v2/organizations/' + org + '/usage?organizationTimezone=true', {
      headers: { Authorization: 'Token ' + token, Accept: 'application/json' },
    });
  } catch (error) {
    const status = /HTTP (\d+)/.exec(error.message)?.[1];
    const hint = { 401: 'token rejected. Check MAKE_API_TOKEN', 403: 'token needs the organizations:read scope', 404: 'organization not found in ' + zone + '. Check MAKE_ORG_ID and MAKE_ZONE' }[status];
    throw hint ? new ExposedError('Make API ' + status + ': ' + hint) : error;
  }
  if (!Array.isArray(data?.data)) throw new ExposedError('Make usage response had no data array');
  // centicredits can arrive as a string (bigint) or be missing on operations-based plans. Fall back to operations.
  return data.data.flatMap(row => {
    const date = String(row?.date || '').slice(0, 10);
    const centi = number(row?.centicredits), ops = number(row?.operations);
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || (centi === null && ops === null)) return [];
    return [{ date, credits: centi !== null ? centi / 100 : ops }];
  });
}

export async function cashBalance(env) {
  const url = new URL(required(env, 'CASH_BALANCE_URL'));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid cash balance URL');
  const token = required(env, 'CASH_BALANCE_TOKEN');
  const data = await readJson(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, cache: 'no-store' });
  const balance = number(data?.balance);
  const timestamp = typeof data?.asOf === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(data.asOf) ? Date.parse(data.asOf) : NaN;
  if (balance === null || data.currency !== 'USD' || !Number.isFinite(timestamp) || timestamp > Date.now()) {
    throw new Error('Invalid USD cash balance or timestamp');
  }
  return { balance, asOf: new Date(timestamp).toISOString() };
}
