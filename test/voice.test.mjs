import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import ask from '../netlify/functions/ask.mjs';
import voice from '../netlify/functions/voice.mjs';
import slack from '../netlify/functions/slack-voice.mjs';
import { memoryStore } from '../netlify/functions/lib/voice/state.mjs';

const base = 'http://127.0.0.1:8888';
const response = content => Response.json({ choices: [{ message: { content } }] });

function fixture(overrides = {}) {
  const env = {
    DATA_MODE: 'sample', VOICE_ENABLED: '1', VOICE_ORIGIN: base, DASHBOARD_KEY: 'test-dashboard-key',
    MCP_KEY: 'test-internal-mcp-key', VOICE_APPROVED_REASONING: 'groq,gemini', GROQ_API_KEY: 'test-groq',
    GEMINI_API_KEY: 'test-gemini', VOICE_GEMINI_MODEL: 'test-model',
    SLACK_SIGNING_SECRET: 'test-slack-signing-secret', VOICE_SLACK_APP_ID: 'A99',
    VOICE_SLACK_LINKS: '{"T01:U01":"ghl-user"}', GHL_MARKETPLACE_COMPANY_ID: 'company', GHL_LOCATION_ID: 'location',
    GHL_MARKETPLACE_ALLOWED_USERS: 'ghl-user', GHL_APP_SHARED_SECRET: 'test-shared-key',
    GHL_SESSION_SECRET: 'test-session-secret-long-enough-12345', ...overrides,
  };
  const calls = [];
  const context = {
    env, store: memoryStore(),
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.includes('groq.com') && options.body instanceof FormData) return Response.json({ text: 'What is our runway?' });
      if (url.includes('groq.com')) return new Response(null, { status: 429 });
      if (url === 'http://tts.test/speech') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
      return response('Sample runway is approximately four months.');
    },
  };
  const makeRequest = (action, data, headers = {}) => new Request(base + (action === 'turn' ? '/api/ask' : '/api/voice'), {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...data }),
  });
  const call = (action, data, headers) => (action === 'turn' ? ask : voice)(makeRequest(action, data, headers), context);
  const start = async () => {
    const result = await call('start', {}, { 'x-a2z-key': env.DASHBOARD_KEY });
    assert.equal(result.status, 200);
    return { 'x-a2z-voice': (await result.json()).token };
  };
  return { env, calls, call, start, context };
}

function wav() {
  const file = Buffer.alloc(3244);
  file.write('RIFF');
  file.writeUInt32LE(file.length - 8, 4);
  file.write('WAVEfmt ', 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(16000, 24);
  file.writeUInt32LE(32000, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(file.length - 44, 40);
  return file.toString('base64');
}

test('voice requires an approved origin, authenticated session and approved reasoning', async () => {
  const f = fixture();
  assert.equal((await f.call('start', {}, { Origin: 'https://other.test', 'x-a2z-key': f.env.DASHBOARD_KEY })).status, 403);
  assert.equal((await f.call('start', {})).status, 401);
  const auth = await f.start();
  assert.equal((await f.call('resume', {}, auth)).status, 200);
  f.env.DASHBOARD_KEY = 'new-dashboard-key';
  assert.equal((await f.call('resume', {}, auth)).status, 401);
  f.env.VOICE_APPROVED_REASONING = '';
  assert.equal((await f.call('start', {}, { 'x-a2z-key': f.env.DASHBOARD_KEY })).status, 503);
});

test('audio traverses local failure, Groq STT, real sample MCP, Gemini fallback, and local TTS', async () => {
  const f = fixture({ VOICE_WHISPER_URL: 'http://stt.test/transcriptions', VOICE_GROQ_STT_APPROVED: '1', VOICE_TTS_URL: 'http://tts.test/speech' });
  const original = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    if (url !== f.env.VOICE_WHISPER_URL) return original(url, options);
    f.calls.push({ url, options });
    return new Response(null, { status: 502 });
  };
  const auth = await f.start();
  const turn = { id: randomUUID(), audio: wav(), history: [], speak: true };
  const concurrent = await Promise.all([f.call('turn', turn, auth), f.call('turn', turn, auth)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const result = await concurrent.find(item => item.ok).json();
  assert.equal(result.transcript, 'What is our runway?');
  assert.equal(result.provider, 'gemini');
  assert.deepEqual(result.audio, { type: 'audio/mpeg', base64: 'AQID' });
  assert.deepEqual(Object.keys(result.timings), ['mcpMs', 'reasoningMs', 'sttMs', 'ttsMs']);
  assert.equal(f.calls.length, 5);
  const messages = JSON.parse(f.calls[3].options.body).messages;
  const report = JSON.parse(messages.at(-1).content).operatingReport;
  assert.equal(report.mode, 'sample');
  assert.ok(report.dispatchToday.bookedJobLabels.length > 0);
  assert.equal(report.dispatchToday.crew, undefined);
  assert.equal(f.calls[1].options.body.get('file').size, 3244);
  assert.equal((await f.call('end', {}, auth)).status, 200);
  assert.equal((await f.call('resume', {}, auth)).status, 401);
});

test('accepted turns are capped across sessions and reconnect preserves the duplicate record', async () => {
  const f = fixture({ VOICE_DAILY_TURNS: '1' });
  const first = await f.start();
  const second = await f.start();
  const turn = { id: randomUUID(), text: 'How many proposals went out this week?', history: [] };
  const result = await f.call('turn', turn, first);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).preset, 'wtd');
  assert.equal((await f.call('resume', {}, first)).status, 200);
  assert.equal((await f.call('turn', turn, first)).status, 409);
  assert.equal((await f.call('turn', turn, second)).status, 429);
  assert.equal(f.calls.length, 2);
});

test('interrupt aborts an in-flight model call in the same instance', async () => {
  const f = fixture();
  const auth = await f.start();
  const { promise, resolve } = Promise.withResolvers();
  let canceled = false;
  f.context.fetchImpl = async (_url, { signal }) => {
    resolve();
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => { canceled = true; reject(signal.reason); }, { once: true });
    });
  };
  const turn = { id: randomUUID(), text: 'Check Twilio balance', history: [] };
  const pending = f.call('turn', turn, auth);
  await promise;
  assert.equal((await f.call('cancel', { id: turn.id }, auth)).status, 200);
  assert.equal((await pending).status, 409);
  assert.ok(canceled);
});

test('Slack validates the signature and age, issues a private link, and permits exactly one redemption', async () => {
  const f = fixture();
  const now = Date.now();
  const body = 'team_id=T01&user_id=U01&api_app_id=A99&command=%2Fcall-a2z';
  const signed = (timestamp, payload = body, submitted = payload) => {
    const signature = createHmac('sha256', f.env.SLACK_SIGNING_SECRET).update('v0:' + timestamp + ':' + payload).digest('hex');
    return slack(new Request(base + '/api/slack/voice', {
      method: 'POST', body: submitted,
      headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + signature },
    }), { env: f.env, now });
  };
  const seconds = Math.floor(now / 1000);
  assert.equal((await signed(seconds - 400)).status, 401);
  assert.equal((await signed(seconds, body, body + '&text=tampered')).status, 401);
  const result = await signed(seconds);
  const value = await result.json();
  assert.equal(value.response_type, 'ephemeral');
  assert.equal(value.unfurl_links, false);
  assert.equal((await (await signed(seconds)).json()).text, value.text);
  const launch = value.text.match(/#launch=([^|]+)/)[1];
  const redeemed = await Promise.all([f.call('start', { launch }), f.call('start', { launch })]);
  assert.deepEqual(redeemed.map(item => item.status).sort(), [200, 409]);
  const session = await redeemed.find(item => item.ok).json();
  f.env.VOICE_SLACK_LINKS = '{}';
  assert.equal((await f.call('resume', {}, { 'x-a2z-voice': session.token })).status, 401);
  assert.match((await (await signed(seconds)).json()).text, /not linked/);
});
