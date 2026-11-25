// Operations forwards the operator's booking request. The Desk owns the
// preview, confirmation hash, duplicate check, and write.
export async function createOpportunity(body, { env = process.env, fetchImpl = fetch } = {}) {
  let url;
  try {
    const base = new URL(env.ESTIMATING_URL);
    if (base.protocol !== 'https:' || base.username || base.password || !env.ESTIMATING_ACTION_KEY) throw new Error();
    url = new URL('/.netlify/functions/jarvis-actions', base);
  } catch {
    return { status: 503, data: { error: 'The Estimating Desk action is not configured.' } };
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-action-key': env.ESTIMATING_ACTION_KEY },
      body: JSON.stringify({ ...body, action: 'create_opportunity' }),
      redirect: 'error',
      signal: AbortSignal.timeout(9000),
    });
    if (![200, 202, 400, 409, 422, 503].includes(response.status)) throw new Error();
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    if (response.ok && !body.dryRun) data.deskUrl = url.origin;
    return { status: response.status, data };
  } catch {
    return { status: 502, data: { error: 'The Estimating Desk did not return a booking result.' } };
  }
}

// Jose change orders and proposals. Same bridge, key and preview/confirm contract as createOpportunity.
const DESK_ACTIONS = new Set(['draft_change_order', 'start_proposal']);
export async function deskAction(body, { env = process.env, fetchImpl = fetch, scoped = false } = {}) {
  if (!DESK_ACTIONS.has(body?.action)) return { status: 400, data: { error: 'Unknown Desk action.' } };
  let url;
  try {
    const base = new URL(env.ESTIMATING_URL);
    if (base.protocol !== 'https:' || base.username || base.password || !env.ESTIMATING_ACTION_KEY) throw new Error();
    url = new URL('/.netlify/functions/jarvis-actions', base);
  } catch {
    return { status: 503, data: { error: 'The Estimating Desk action is not configured.' } };
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-action-key': env.ESTIMATING_ACTION_KEY },
      body: JSON.stringify(scoped ? { ...body, operation: body.action, action: "jose_write" } : body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (![200, 400, 403, 404, 409, 422, 502, 503].includes(response.status)) throw new Error();
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return { status: response.status, data };
  } catch {
    return { status: 502, data: { error: 'The Estimating Desk did not return a result.' } };
  }
}
