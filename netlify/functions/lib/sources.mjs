import { MissingConfiguration, number, readJson, required } from './http.mjs';

export const siteKeys = { Estimating: 'ESTIMATING', Dispatch: 'DISPATCH', Ledger: 'LEDGER' };

export async function source(load) {
  try {
    return { status: 'ok', data: await load() };
  } catch (error) {
    if (error instanceof MissingConfiguration) return { status: 'setup', detail: error.message };
    const upstream = /^Upstream HTTP (\d+)$/.exec(error.message);
    return { status: 'error', detail: upstream ? 'Upstream HTTP ' + upstream[1] : 'Upstream unavailable or invalid response' };
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

export async function makeUsage(env) {
  const zone = required(env, 'MAKE_ZONE');
  const org = required(env, 'MAKE_ORG_ID');
  const token = required(env, 'MAKE_API_TOKEN');
  if (!/^(us|eu)[12]\.make\.com$/.test(zone) || !/^\d+$/.test(org)) throw new Error('Invalid Make configuration');
  const data = await readJson('https://' + zone + '/api/v2/organizations/' + org + '/usage?organizationTimezone=true', {
    headers: { Authorization: 'Token ' + token },
  });
  if (!Array.isArray(data.data) || data.data.some(row => number(row.centicredits) === null || !/^\d{4}-\d\d-\d\d$/.test(row.date))) {
    throw new Error('Invalid Make usage');
  }
  return data.data.map(row => ({ date: row.date, credits: number(row.centicredits) / 100 }));
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
