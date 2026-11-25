import assert from 'node:assert/strict';
import test from 'node:test';
import mcp from '../netlify/functions/mcp.mjs';
import { emailMetrics, emailTool } from '../netlify/functions/lib/email-mcp.mjs';

const key = 'mcp-client-key-at-least-sixteen';

test('email app tools are listed only when configured and proxy to the email MCP server', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), auth: init.headers.Authorization, body });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { items: [{ id: 'INBOX:7:10', subject: 'ITB Bristol', due: '2026-12-04' }] }, content: [] } });
  };
  const rpc = async (method, params, env) => (await mcp(new Request('https://ops.example/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  }), { env: { MCP_KEY: key, ...env }, fetchImpl })).json();
  assert.equal((await rpc('tools/list', {}, {})).result.tools.some(tool => tool.name === 'email_search'), false);
  const env = { EMAIL_MCP_API_KEY: 'email-read-key-0000000000000000000000' };
  const names = (await rpc('tools/list', {}, env)).result.tools.map(tool => tool.name);
  for (const name of ['email_search', 'email_get_deadlines', 'email_get_briefing', 'email_get_metrics', 'email_get_ai_usage']) assert.ok(names.includes(name), name);
  assert.equal(names.includes('email_create_draft'), false, 'drafts need the write key');
  const result = await rpc('tools/call', { name: 'email_get_deadlines', arguments: { dateFrom: '2026-11-25', dateTo: '2026-12-01' } }, env);
  assert.equal(result.result.structuredContent.items[0].id, 'INBOX:7:10');
  assert.equal(seen[0].url, 'https://a2zemails.netlify.app/mcp');
  assert.equal(seen[0].auth, 'Bearer email-read-key-0000000000000000000000');
  assert.deepEqual(seen[0].body.params, { name: 'email_get_deadlines', arguments: { dateFrom: '2026-11-25', dateTo: '2026-12-01' } });
});

test('email tool errors and unavailable metrics are reported, not invented', async () => {
  const env = { EMAIL_MCP_API_KEY: 'email-read-key-0000000000000000000000', EMAIL_MCP_URL: 'https://mail.example/mcp' };
  await assert.rejects(emailTool('email_search', {}, { env, fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'limit is out of range.' }] } }) }), /out of range/);
  assert.equal(await emailMetrics({ from: '2026-11-01', to: '2026-11-25' }, { env, fetchImpl: async () => new Response(null, { status: 502 }) }), null);
  const metrics = await emailMetrics({ from: '2026-11-02', to: '2026-11-25' }, { env, fetchImpl: async url => {
    assert.equal(url.pathname, '/api/mcp/email-metrics');
    assert.equal(url.searchParams.get('dateFrom'), '2026-11-02');
    return Response.json({ emailsReceived: 40, averageResponseHours: null });
  } });
  assert.deepEqual(metrics, { emailsReceived: 40, averageResponseHours: null });
  assert.equal(await emailMetrics({}, { env: {} }), null);
});
