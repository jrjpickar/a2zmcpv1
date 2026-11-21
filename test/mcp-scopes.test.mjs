import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import mcp from '../netlify/functions/mcp.mjs';
import { actions } from '../netlify/functions/lib/actions.mjs';

const key = 'mcp-client-key-at-least-sixteen';
const reportsOnly = 'scoped-reports-token-0123456789';
const sha = value => createHash('sha256').update(value).digest('hex');
const env = { MCP_KEY: key, MCP_MAIL_TOKEN: 'read', MCP_MAIL_DRAFT_TOKEN: 'draft', DATA_MODE: 'sample',
  MCP_TOKENS: JSON.stringify([{ name: 'reports', sha256: sha(reportsOnly), scopes: ['report:read'] }]) };
const rpc = (token, method, params, over = env) => mcp(new Request('https://ops.example/mcp', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}), { env: over, fetchImpl: async () => Response.json({ status: 'draft_saved' }) }).then(r => r.json().then(body => ({ status: r.status, body })));

test('main key keeps every tool; a scoped token sees and calls only its scope', async () => {
  assert.equal((await rpc(key, 'tools/list')).body.result.tools.length, 6);
  const scoped = await rpc(reportsOnly, 'tools/list');
  assert.deepEqual(scoped.body.result.tools.map(tool => tool.name), ['a2z_operating_report']);
  const report = await rpc(reportsOnly, 'tools/call', { name: 'a2z_operating_report', arguments: { preset: 'mtd' } });
  assert.equal(report.body.result.structuredContent.mode, 'sample');
  const draft = await rpc(reportsOnly, 'tools/call', { name: 'a2z_mail_create_draft', arguments: { id: '2469fce3-ae54-4d08-bd4c-618f4828ea13', body: 'x' } });
  assert.equal(draft.body.error.message, 'Unknown tool');
  assert.equal((await rpc('not-a-known-token-0123456789', 'tools/list')).status, 401);
});

test('broken MCP_TOKENS never locks out the main key', async () => {
  const broken = { ...env, MCP_TOKENS: '{not json' };
  assert.equal((await rpc(key, 'tools/list', undefined, broken)).status, 200);
  assert.equal((await rpc(reportsOnly, 'tools/list', undefined, broken)).status, 401);
});

test('every action has a scope, a risk level and a run function; writes stay off MCP', () => {
  for (const entry of actions) {
    assert.ok(['report:read', 'mail:read', 'mail:draft', 'desk:write'].includes(entry.scope), entry.name);
    assert.ok(['read', 'draft', 'write'].includes(entry.risk), entry.name);
    assert.equal(typeof entry.run, 'function');
    if (entry.risk === 'write') assert.equal(entry.mcp, false, entry.name);
  }
});
