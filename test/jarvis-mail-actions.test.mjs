import test from 'node:test';
import assert from 'node:assert/strict';
import { mailActions } from '../netlify/functions/lib/jarvis-mail-actions.mjs';
import { classifyTopic } from '../netlify/functions/lib/classify-topic.mjs';

test('Email agent uses the existing mailbox draft endpoint and draft credential', async () => {
  let requests = 0;
  const actions = mailActions({
    env: { MCP_MAIL_TOKEN: 'read', MCP_MAIL_DRAFT_TOKEN: 'draft' },
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url.pathname, '/api/mcp/mail/draft');
      assert.equal(options.headers.Authorization, 'Bearer draft');
      assert.equal(options.method, 'POST');
      const saved = JSON.parse(options.body);
      assert.equal(saved.to, 'gc@example.com');
      assert.equal(saved.subject, 'Walkthrough');
      return Response.json({ id: saved.id, status: 'draft_saved' });
    },
  });
  const model = async () => ({ tool: 'draft', arguments: { to: 'gc@example.com', subject: 'Walkthrough', body: 'Can we walk the site Tuesday?' } });
  assert.match(await actions({ prompt: 'Draft an email confirming the walkthrough', model }), /^Draft saved/);
  assert.match(await actions({ prompt: 'Read the inbox', model }), /tool is unavailable/);
  assert.equal(requests, 1);
});

test('topic classification uses keywords first and accepts a low-confidence new topic', async () => {
  let calls = 0;
  const options = { env: { GROQ_API_KEY: 'test-key' }, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).model, 'openai/gpt-oss-20b');
    return Response.json({ choices: [{ message: { content: '{"topic":"Fleet","confidence":0.3}' } }] });
  } };
  assert.equal(await classifyTopic('Review bid costs', options), 'Estimating');
  assert.equal(await classifyTopic('Vehicle ownership records', options), 'Fleet');
  assert.equal(calls, 1);
});
