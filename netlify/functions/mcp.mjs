import { createHash, timingSafeEqual } from 'node:crypto';
import { authorized, json } from './lib/http.mjs';
import { actions, allowed, mcpTool, SCOPES } from './lib/actions.mjs';

const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];

// Who is calling. MCP_KEY (MCP_AUTH_TOKEN on the VM) keeps full access, as before.
// Optional MCP_TOKENS adds scoped tokens: [{ "name": "reports", "sha256": "<hex of the token>", "scopes": ["report:read"] }].
// Only token hashes are stored. A broken MCP_TOKENS value is ignored, so the main key always works.
export function scopesFor(request, env) {
  if (authorized(request, env.MCP_KEY, 'authorization')) return new Set(['*']);
  const supplied = /^Bearer (.+)$/i.exec(request.headers.get('authorization') || '')?.[1] || '';
  if (supplied.length < 16 || !env.MCP_TOKENS) return null;
  let entries;
  try { entries = JSON.parse(env.MCP_TOKENS); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const digest = createHash('sha256').update(supplied).digest();
  for (const entry of entries) {
    if (typeof entry?.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256) || !Array.isArray(entry.scopes)) continue;
    if (timingSafeEqual(digest, Buffer.from(entry.sha256, 'hex'))) return new Set(entry.scopes.filter(scope => SCOPES.includes(scope)));
  }
  return null;
}

export default async (request, { env = process.env, fetchImpl = fetch } = {}) => {
  const scopes = scopesFor(request, env);
  if (!scopes) {
    return json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  let msg;
  try {
    const body = await request.text();
    if (body.length > 16000) return json({ error: 'Payload too large' }, 413);
    msg = JSON.parse(body);
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const id = msg?.id ?? null;
  const respond = result => json({ jsonrpc: '2.0', id, result });
  const fail = (code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request', 400);
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const tools = actions.filter(entry => entry.mcp && entry.enabled(env) && allowed(entry, scopes));
  const version = msg.params?.protocolVersion;
  switch (msg.method) {
    case 'initialize': return respond({ protocolVersion: protocols.includes(version) ? version : protocols[0],
      capabilities: { tools: {} }, serverInfo: { name: 'a2z-mcp', version: '1.0.0' } });
    case 'ping': return respond({});
    case 'tools/list': return respond({ tools: tools.map(mcpTool) });
    case 'tools/call': {
      const name = msg.params?.name;
      const entry = tools.find(item => item.name === name);
      if (!entry) return fail(-32602, 'Unknown tool');
      const args = msg.params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'Invalid arguments');
      try {
        const data = await entry.run(args, { env, fetchImpl });
        return respond({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (error) {
        const message = entry.name === 'a2z_operating_report'
          ? (error instanceof RangeError ? error.message : 'Report unavailable')
          : (error.mailError ? error.message : error.retryAfter ? 'The mailbox rate limit was reached. Try again shortly.' : 'Mailbox request failed. Check the arguments and try again.');
        return respond({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default: return fail(-32601, 'Method not found');
  }
};
export const config = { path: '/mcp' };
