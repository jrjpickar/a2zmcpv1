// Client for the A2Z Email app's MCP server (Streamable HTTP, JSON responses).
// EMAIL_MCP_URL defaults to https://a2zemails.netlify.app/mcp. EMAIL_MCP_API_KEY reads; EMAIL_MCP_WRITE_API_KEY saves drafts.
// The email app runs its tools in code (no AI), so the orchestrator does the reasoning.

export const defaultEmailMcpUrl = 'https://a2zemails.netlify.app/mcp';
export const emailMetricsPath = '/api/mcp/email-metrics';

export function emailMcpUrl(env) {
  try {
    const url = new URL(env.EMAIL_MCP_URL?.trim() || defaultEmailMcpUrl);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url : null;
  } catch { return null; }
}

let counter = 0;
export async function emailTool(name, args, { env, fetchImpl = fetch, write = false }) {
  const token = (write ? env.EMAIL_MCP_WRITE_API_KEY : env.EMAIL_MCP_API_KEY)?.trim();
  const url = emailMcpUrl(env);
  if (!token || !url) throw Object.assign(new Error('The email MCP connection is not configured.'), { mailError: true });
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(28000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++counter, method: 'tools/call', params: { name, arguments: args ?? {} } }),
  });
  if (response.status === 429) throw Object.assign(new Error('Email rate limit'), { retryAfter: Number(response.headers.get('retry-after')) || 30 });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'The email MCP key was rejected.' : 'The email app is unavailable.'), { mailError: true });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(data.error.message || 'Email tool error'), { mailError: true });
  if (data.result?.isError) throw Object.assign(new Error(data.result.content?.[0]?.text || 'Email tool error'), { mailError: true });
  return data.result?.structuredContent ?? JSON.parse(data.result?.content?.[0]?.text || '{}');
}

// Email KPIs for the dashboard. Returns null when the email app is unavailable (never zeros).
const cache = new Map();
export async function emailMetrics(range, { env, fetchImpl = fetch, now = Date.now } = {}) {
  const token = env.EMAIL_MCP_API_KEY?.trim();
  const base = emailMcpUrl(env);
  if (!token || !base) return null;
  const url = new URL(emailMetricsPath, base);
  if (range?.from) url.searchParams.set('dateFrom', range.from);
  if (range?.to) url.searchParams.set('dateTo', range.to);
  const hit = cache.get(url.href);
  if (hit && now() - hit.at < 5 * 60 * 1000) return hit.value;
  try {
    const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const value = await response.json();
    cache.set(url.href, { at: now(), value });
    return value;
  } catch { return null; }
}
