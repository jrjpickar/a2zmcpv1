import assert from 'node:assert/strict';
import test from 'node:test';
import mcp from '../netlify/functions/mcp.mjs';
import { fetchMailbox } from '../netlify/functions/lib/jarvis-mail.mjs';

test('MCP mail tool discovery and calls use separate server-side read and draft credentials', async () => {
  const key = 'mcp-client-key-at-least-sixteen';
  const env = { MCP_KEY: key, MCP_MAIL_TOKEN: 'read-only-token', MCP_MAIL_DRAFT_TOKEN: 'draft-only-token' };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ path: url.pathname, query: url.searchParams, ...init });
    return Response.json(url.pathname.endsWith('/draft') ? { status: 'draft_saved' } : { body: 'Message text' });
  };
  const rpc = async (method, params, options = {}) => {
    const response = await mcp(new Request('https://ops.example/mcp', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    }), { env, fetchImpl, ...options });
    return response.json();
  };
  const { result } = await rpc('tools/list');
  assert.deepEqual(result.tools.map(tool => tool.name), [
    'a2z_operating_report', 'a2z_mail_folders', 'a2z_mail_list', 'a2z_mail_read',
    'a2z_mail_command_center', 'a2z_mail_create_draft',
  ]);
  assert.equal((await rpc('tools/list', {}, { env: { MCP_KEY: key } })).result.tools.length, 1);
  const read = await rpc('tools/call', { name: 'a2z_mail_read', arguments: { id: 'INBOX:42:10' } });
  assert.equal(read.result.structuredContent.body, 'Message text');
  assert.equal(seen[0].headers.Authorization, 'Bearer read-only-token');
  assert.equal(seen[0].query.get('id'), 'INBOX:42:10');
  const args = { id: '2469fce3-ae54-4d08-bd4c-618f4828ea13', to: 'crew@example.test', body: 'Confirm crew.' };
  const draft = await rpc('tools/call', { name: 'a2z_mail_create_draft', arguments: args });
  assert.equal(draft.result.structuredContent.status, 'draft_saved');
  assert.equal(seen[1].path, '/api/mcp/mail/draft');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].headers.Authorization, 'Bearer draft-only-token');
  assert.deepEqual(JSON.parse(seen[1].body), { ...args, cc: '', bcc: '', subject: '' });
});

test('JARVIS gets counts and message bodies through their respective endpoints', async () => {
  const env = { MCP_COMMAND_CENTER_TOKEN: 'counts', MCP_MAIL_TOKEN: 'read', JARVIS_EMAIL_PAGES: '2' };
  const fetchImpl = async (url, { headers }) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/mcp/command-center') {
      assert.equal(headers.Authorization, 'Bearer counts');
      return Response.json({ stats: { unreadIncoming: 2 } });
    }
    assert.equal(headers.Authorization, 'Bearer read');
    if (pathname.endsWith('/messages')) {
      if (!searchParams.has('before')) return Response.json({ messages: [], hasMore: true, uidValidity: '42', next: 2 });
      assert.equal(searchParams.get('before'), '2');
      return Response.json({ messages: [{ id: 'INBOX:42:1' }], hasMore: false });
    }
    return Response.json({ subject: 'Schedule', body: 'Meet at 4.' });
  };
  const snapshot = await fetchMailbox({ env, fetchImpl });
  assert.equal(snapshot.stats.unreadIncoming, 2);
  assert.equal(snapshot.messagesAvailable, true);
  assert.equal(snapshot.messages[0].text, 'Meet at 4.');
});
