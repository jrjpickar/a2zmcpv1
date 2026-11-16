import { authorized, json } from './lib/http.mjs';
import { report } from './lib/report.mjs';

const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
const tool = {
  name: 'a2z_operating_report',
  description: 'Read A2Z leads, proposals, jobs won, labor and container sales, workforce, runway and system health.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { type: 'object', properties: {
    preset: { type: 'string', enum: ['today', 'wtd', 'mtd', '30d', 'ytd'] },
    from: { type: 'string', description: 'Pacific date YYYY-MM-DD. Requires to.' },
    to: { type: 'string', description: 'Pacific date YYYY-MM-DD. Requires from.' },
  } },
};

export default async request => {
  if (!authorized(request, process.env.MCP_KEY, 'authorization')) {
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
  const version = msg.params?.protocolVersion;
  switch (msg.method) {
    case 'initialize': return respond({ protocolVersion: protocols.includes(version) ? version : protocols[0],
      capabilities: { tools: {} }, serverInfo: { name: 'a2z-mcp', version: '1.0.0' } });
    case 'ping': return respond({});
    case 'tools/list': return respond({ tools: [tool] });
    case 'tools/call': {
      if (msg.params?.name !== tool.name) return fail(-32602, 'Unknown tool');
      try {
        const data = await report(msg.params.arguments ?? {});
        return respond({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (error) {
        return respond({ content: [{ type: 'text', text: error instanceof RangeError ? error.message : 'Report unavailable' }], isError: true });
      }
    }
    default: return fail(-32601, 'Method not found');
  }
};
export const config = { path: '/mcp' };
