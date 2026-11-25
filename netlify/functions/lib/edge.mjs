// Client for the A2Z Jose edge worker (edge/src/index.mjs on Cloudflare Workers).
// Env: EDGE_URL (https origin of the worker), EDGE_KEY (its bearer secret).
export async function edge(path, body, { env = process.env, fetchImpl = fetch, signal } = {}) {
  let url;
  try {
    const base = new URL(env.EDGE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || !env.EDGE_KEY) throw new Error();
    url = new URL(path, base);
  } catch {
    throw Object.assign(new Error('The Jose edge worker is not configured.'), { status: 503 });
  }
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + env.EDGE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !data || typeof data !== 'object') {
    throw Object.assign(new Error(typeof data?.error === 'string' ? data.error.slice(0, 200) : 'The Jose edge worker did not answer.'), { status: response.status === 429 ? 429 : 502 });
  }
  return data;
}

// pipelines: any of demo, labor, containers, change_orders (default all four).
export const findJobs = (query, { won = false, limit = 3, pipelines } = {}, options) => edge('/v1/jobs/search', { query, won, limit, ...(pipelines ? { pipelines } : {}) }, options);
export const readTexts = (input, options) => edge('/v1/texts', input, options);
