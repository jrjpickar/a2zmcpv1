// Gemini and Workers AI agents, custom instructions, and the Slack bot. No live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createInstructionsHandler, instructionsText } from '../netlify/functions/jarvis-instructions.mjs';
import { createSlackEventsHandler } from '../netlify/functions/slack-events.mjs';
import { createSlackWorker, parseMessage, toSlack, verifySlack } from '../netlify/functions/lib/slack.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { env, get, groqReply, post } from './jarvis-helpers.mjs';

const report = { range: { from: '2026-11-01', to: '2026-11-18' }, funnel: { wins: 4 } };
const gemReply = text => Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 50 } });
const cfReply = text => Response.json({ choices: [{ message: { content: text } }], usage: { total_tokens: 40 } });
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';

function providers(groqAnswer = 'groq answer') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    url = String(url);
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return gemReply('Gemini says wins are 4.');
    if (url.startsWith('https://api.cloudflare.com/')) return cfReply('Workers AI says wins are 4.');
    if (url === 'https://api.groq.com/openai/v1/chat/completions') return groqReply(groqAnswer);
    throw new Error('Unexpected fetch ' + url);
  };
  return { calls, fetchImpl };
}

test('Gemini agent calls generateContent with the key header and system instruction', async () => {
  const p = providers();
  const run = createJarvisHandler({ env: { ...env, GEMINI_API_KEY: 'gem-key' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => memoryAdapter() });
  const data = await (await run(post('/api/jarvis', { role: 'gemini', prompt: 'Second opinion on wins?' }))).json();
  assert.equal(data.answer, 'Gemini says wins are 4.');
  assert.deepEqual(data.trace, ['gemini']);
  const call = p.calls.find(c => c.url.includes('generativelanguage'));
  assert.match(call.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(call.headers['x-goog-api-key'], 'gem-key');
  assert.match(call.body.systemInstruction.parts[0].text, /Gemini agent/);
});

test('Gemini works without a Groq key, and is refused when unset', async () => {
  const p = providers();
  const only = createJarvisHandler({ env: { DASHBOARD_KEY: env.DASHBOARD_KEY, GEMINI_API_KEY: 'gem-key' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => memoryAdapter() });
  assert.equal((await only(post('/api/jarvis', { role: 'gemini', prompt: 'hi' }))).status, 200);
  const none = createJarvisHandler({ env, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => memoryAdapter() });
  const res = await none(post('/api/jarvis', { role: 'gemini', prompt: 'hi' }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /GEMINI_API_KEY/);
});

test('Main routes "second opinion" to Gemini and "llama" to Workers AI', async () => {
  const p = providers();
  const run = createJarvisHandler({ env: { ...env, GEMINI_API_KEY: 'g', CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, CLOUDFLARE_AI_TOKEN: 'cf' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => memoryAdapter() });
  assert.deepEqual((await (await run(post('/api/jarvis', { role: 'main', prompt: 'Give me a second opinion' }))).json()).trace, ['main', 'gemini']);
  assert.deepEqual((await (await run(post('/api/jarvis', { role: 'main', prompt: 'Ask llama for ideas' }))).json()).trace, ['main', 'cloudflare']);
});

test('Workers AI agent uses the OpenAI compatible endpoint and default Llama model', async () => {
  const p = providers();
  const run = createJarvisHandler({ env: { ...env, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, CLOUDFLARE_AI_TOKEN: 'cf-token' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => memoryAdapter() });
  const data = await (await run(post('/api/jarvis', { role: 'cloudflare', prompt: 'Draft a follow up' }))).json();
  assert.equal(data.answer, 'Workers AI says wins are 4.');
  const call = p.calls.find(c => c.url.includes('cloudflare'));
  assert.equal(call.url, 'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT + '/ai/v1/chat/completions');
  assert.equal(call.body.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(call.headers.authorization, 'Bearer cf-token');
});

test('custom instructions save, load and reach every agent prompt', async () => {
  const store = memoryAdapter();
  const handler = createInstructionsHandler({ env, openStore: () => store });
  assert.equal((await handler(post('/api/jarvis-instructions', { about: 1 }))).status, 400);
  const saved = await (await handler(post('/api/jarvis-instructions', { about: 'I run estimating — bids first.', style: 'Short bullets.' }))).json();
  assert.equal(saved.about, 'I run estimating - bids first.');
  assert.equal((await (await handler(get('/api/jarvis-instructions'))).json()).style, 'Short bullets.');
  const p = providers('ok');
  const run = createJarvisHandler({ env, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: () => store });
  await run(post('/api/jarvis', { role: 'systems', prompt: 'How are wins?' }));
  assert.match(p.calls[0].body.messages[0].content, /About the operator: I run estimating - bids first\.[\s\S]*How to respond: Short bullets\./);
  assert.equal(instructionsText({ about: 'x', enabled: false }), '');
});

const sign = (secret, body, stamp = Math.floor(Date.now() / 1000)) => ({
  'x-slack-request-timestamp': String(stamp), 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update('v0:' + stamp + ':' + body).digest('hex'),
});
const slackEnv = { ...env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'slack-secret', SLACK_ALLOWED_USERS: 'U0OWNER1' };

test('Slack events: signature, url_verification, retries and dispatch', async () => {
  const sent = [];
  const handler = createSlackEventsHandler({ env: slackEnv, dispatch: async work => sent.push(JSON.parse(work)) });
  const req = (body, headers) => new Request('https://ops.a2z.test/api/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  assert.equal((await handler(req(challenge, { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=bad' }))).status, 401);
  assert.equal((await (await handler(req(challenge, sign('slack-secret', challenge)))).json()).challenge, 'abc');
  const event = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'app_mention', user: 'U0OWNER1', text: '<@UBOT> hi', channel: 'C1', ts: '1.1' } });
  assert.equal((await handler(req(event, sign('slack-secret', event)))).status, 200);
  assert.equal((await handler(req(event, { ...sign('slack-secret', event), 'x-slack-retry-num': '1' }))).status, 200);
  assert.equal((await handler(req(event, sign('slack-secret', event)))).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.text, '<@UBOT> hi');
  assert.equal(verifySlack(new Headers(sign('slack-secret', 'x', 1000)), 'x', 'slack-secret'), false);
});

test('Slack parsing and formatting', () => {
  assert.deepEqual(parseMessage('<@UBOT> systems: how are wins?'), { role: 'systems', prompt: 'how are wins?' });
  assert.deepEqual(parseMessage('gemini: draft an email'), { role: 'gemini', prompt: 'draft an email' });
  assert.deepEqual(parseMessage('workers: ideas'), { role: 'cloudflare', prompt: 'ideas' });
  assert.deepEqual(parseMessage('remember: short answers'), { role: 'main', prompt: 'remember: short answers' });
  assert.deepEqual(parseMessage('Bid Coach: check invites', [{ id: 'bot-bid-coach', name: 'Bid Coach' }]), { role: 'bot-bid-coach', prompt: 'check invites' });
  assert.equal(parseMessage('help').command, 'help');
  assert.equal(parseMessage('run plan').command, 'run');
  assert.equal(toSlack('**Wins**\n- 4 jobs'), '*Wins*\n• 4 jobs');
});

test('Slack worker: DM goes through JARVIS, keeps the thread, ignores strangers, and reactions teach', async () => {
  const store = memoryAdapter();
  const slack = [];
  const p = providers('Wins are 4.');
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://slack.com/api/')) {
      const body = JSON.parse(init.body); slack.push({ method: String(url).split('/').pop(), body });
      return Response.json({ ok: true, ts: '99.1' });
    }
    return p.fetchImpl(url, init);
  };
  const jarvis = createJarvisHandler({ env: slackEnv, fetchImpl, readSystems: async () => report, openStore: () => store });
  const work = createSlackWorker({ env: slackEnv, fetchImpl, openStore: () => store, jarvis });
  await work({ type: 'message', channel_type: 'im', user: 'UOTHER99', text: 'systems: wins?', channel: 'D1', ts: '1.0' });
  assert.equal(slack.length, 0);
  await work({ type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'systems: wins?', channel: 'D1', ts: '1.1' });
  const post1 = slack.find(s => s.method === 'chat.postMessage');
  assert.equal(post1.body.text, 'Wins are 4.');
  assert.equal(post1.body.channel, 'D1');
  await work({ type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'systems: and proposals?', channel: 'D1', ts: '1.2' });
  const groqCalls = p.calls.filter(c => c.url.includes('groq'));
  assert.ok(groqCalls.at(-1).body.messages.some(m => m.role === 'assistant' && m.content === 'Wins are 4.'), 'second turn sees the first answer');
  await work({ type: 'reaction_added', user: 'U0OWNER1', reaction: '+1', item: { type: 'message', channel: 'D1', ts: '99.1' } });
  assert.ok(slack.some(s => s.method === 'reactions.add' && s.body.name === 'brain'));
  await work({ type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'help', channel: 'D1', ts: '1.3' });
  assert.match(slack.filter(s => s.method === 'chat.postMessage').at(-1).body.text, /JARVIS in Slack/);
});
