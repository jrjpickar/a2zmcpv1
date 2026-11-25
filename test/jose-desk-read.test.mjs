import assert from 'node:assert/strict';
import test from 'node:test';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createJarvisMemoryHandler } from '../netlify/functions/jarvis-memory.mjs';
import { createMarketplaceSession } from '../netlify/functions/lib/dashboard-auth.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { get, post } from './jarvis-helpers.mjs';

const address = '3060 Crenshaw Blvd, Los Angeles, CA 90016';
const id = 'jobAutoZone';
const env = { GHL_SESSION_SECRET: 's'.repeat(32), GHL_APP_SHARED_SECRET: 'local-fixture', GHL_MARKETPLACE_COMPANY_ID: 'company',
  GHL_LOCATION_ID: 'loc', GHL_MARKETPLACE_ALLOWED_USERS: 'first,second,viewer', GHL_MARKETPLACE_ADMIN_USERS: 'first,second',
  ESTIMATING_URL: 'https://desk.test', ESTIMATING_ACTION_KEY: 'local-fixture' };
const signIn = userId => ({ 'x-a2z-session': createMarketplaceSession({ userId, companyId: 'company', activeLocation: 'loc' }, env).token });
const stage = { label: 'Current Desk stage', value: 'Pending Decision', source: 'Desk pipeline (HighLevel)' };
const record = { job: { id, name: address }, links: [{ label: 'Open opportunity in HighLevel', url: 'https://app.gohighlevel.com/opportunity' }] };
function fixtures(respond, settings = {}) {
  const calls = [], store = memoryAdapter();
  const handler = createJarvisHandler({ env: { ...env, ...settings }, openStore: async () => store,
    classifier: async () => assert.fail('Desk read must skip model classification'),
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      if (url.hostname === 'api.groq.com' && settings.GROQ_API_KEY) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({ job: '', change: '' }) } }] });
      }
      assert.equal(String(url), env.ESTIMATING_URL + '/.netlify/functions/jarvis-actions');
      calls.push(payload);
      assert.equal(init.headers['x-jarvis-action-key'], env.ESTIMATING_ACTION_KEY);
      assert.ok(init.signal instanceof AbortSignal);
      return respond(payload, init.signal);
    } });
  const memory = createJarvisMemoryHandler({ env, openStore: async () => store });
  const send = (prompt, threadId, user = 'first') => handler(post('/api/jarvis',
    { role: 'main', prompt, ...(threadId ? { threadId } : { newThread: true }) }, signIn(user)));
  return { calls, send, memory, store };
}

test('AutoZone address answers the original question, using a verified ID for later turns', async () => {
  const { calls, send, memory } = fixtures(({ args }) => {
    if (args.query === 'AutoZone') return Response.json({ missing: true });
    const facts = [stage];
    if (args.view === 'dates') facts.push(
      { label: 'Proposal sent', value: null, source: 'Desk proposal draft sentDate' },
      { label: 'Evaluation date', value: null, source: 'Desk' },
      { label: 'Bid due', value: '2026-11-30', source: 'Desk due-date record' });
    if (args.view === 'sent') facts.push({ label: 'Proposal sent', value: '2026-11-20', source: 'Desk proposal draft sentDate' });
    return Response.json({ ...record, facts });
  });
  const first = await (await send('When was the AutoZone bid in Los Angeles sent and evaluated?')).json();
  assert.ok(first.threadId);
  const second = await (await send('it’s ' + address + '.', first.threadId)).json();
  assert.equal(calls[1].args.query, address);
  assert.equal(calls[1].args.view, 'dates');
  assert.match(second.answer, /Pending Decision/);
  assert.match(second.answer, /Evaluation date: No verified value/);
  assert.match(second.answer, /Proposal sent: No verified value/);
  assert.match(second.answer, /Bid due: 2026-11-30/);
  const third = await (await send('when did we send it?', first.threadId)).json();
  assert.deepEqual(calls[2].args, { jobId: id, view: 'sent' });
  assert.match(third.answer, /Proposal sent: 2026-11-20/);
  const fourth = await (await send('open the proposal', first.threadId)).json();
  assert.deepEqual(calls[3].args, { jobId: id, view: 'proposal' });
  assert.equal(fourth.deskLinks.length, 1);
  assert.equal(calls.every(call => call.actor === 'first'), true);
  const other = await memory(get('/api/jarvis-memory?role=main&thread=' + first.threadId, signIn('second')));
  assert.equal(other.status, 404);
});

test('matching parent and CO prompt for explicit selection before fetching details', async () => {
  const { calls, send } = fixtures(({ args }) => Response.json(args.query ? {
    matches: [{ id, name: address, kind: 'Job' }, { id: 'co1', name: address, kind: 'Change order' }], total: 2,
  } : { ...record, job: { ...record.job, id: args.jobId }, facts: [stage] }));
  const first = await (await send(address)).json();
  assert.match(first.answer, /2\. .*Change order/);
  const second = await (await send('option 2', first.threadId)).json();
  assert.equal(calls[1].args.jobId, 'co1');
  assert.equal(second.deskContext.jobId, 'co1');
});

test('Desk denial and abort give a direct response and cannot fall back to a model', async () => {
  const { calls, send } = fixtures((_request, signal) => {
    if (_request.args.view === 'due') {
      const timeout = AbortSignal.timeout(5);
      return new Promise((_resolve, reject) => {
        timeout.addEventListener('abort', () => reject(timeout.reason), { once: true });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => {}, 10);
      });
    }
    return Response.json({}, { status: 403 });
  });
  const denied = await (await send(address)).json();
  assert.match(denied.answer, /does not have Estimating Desk access/);
  const timeout = await (await send('bid due date for ' + address)).json();
  assert.match(timeout.answer, /could not verify/);
  assert.equal(calls.length, 2);
  assert.equal((await send(address, null, 'viewer')).status, 403);
  assert.equal(calls.length, 2);
});

test('opening is read-only and a start requires a preview and exact confirmation in its chat', async () => {
  const { calls, send } = fixtures(payload => {
    if (payload.action === 'read_job') return Response.json({ ...record, facts: [stage] });
    if (payload.dryRun) return Response.json({ preview: { action: 'start_proposal', jobName: address,
      canConfirm: true, hash: 'a'.repeat(64) } });
    return Response.json({ jobName: address });
  }, { GROQ_API_KEY: 'fixture' });
  const open = await (await send('open the proposal for ' + address)).json();
  assert.equal(calls[0].action, 'read_job');
  assert.ok(open.threadId);
  const preview = await (await send('start the estimate', open.threadId)).json();
  assert.match(preview.answer, /Say confirm/);
  assert.deepEqual(calls.at(-1).args, { jobId: id });
  assert.equal(calls.at(-1).dryRun, true);
  await send('confirm the estimate', open.threadId);
  assert.equal(calls.filter(call => call.action === 'jose_write' && !call.dryRun).length, 0);
  const written = await (await send('confirm', open.threadId)).json();
  assert.match(written.answer, /Estimate started/);
  assert.equal(calls.at(-1).dryRun, false);
  assert.equal(calls.at(-1).hash, 'a'.repeat(64));
  assert.equal(calls.at(-1).operation, 'start_proposal');
  assert.equal(calls.filter(call => call.action === 'jose_write' && !call.dryRun).length, 1);
});

test('signed-in voice resolves an address and keeps the job ID in its session', async () => {
  const { randomUUID } = await import('node:crypto');
  const { default: voice } = await import('../netlify/functions/voice.mjs');
  const { default: ask } = await import('../netlify/functions/ask.mjs');
  const { memoryStore } = await import('../netlify/functions/lib/voice/state.mjs');
  const base = 'https://ops.a2z.test';
  const calls = [];
  const ctx = { env: { ...env, VOICE_ENABLED: '1', VOICE_ORIGIN: base, VOICE_APPROVED_REASONING: 'groq',
    GROQ_API_KEY: 'mock', MCP_KEY: 'fixture-mcp-key-123' }, store: memoryStore(),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), env.ESTIMATING_URL + '/.netlify/functions/jarvis-actions');
      calls.push(JSON.parse(init.body));
      return Response.json({ ...record, facts: [stage] });
    } };
  const started = await voice(post('/api/voice', { action: 'start' }, signIn('first')), ctx);
  assert.equal(started.status, 200);
  const headers = { 'x-a2z-voice': (await started.json()).token };
  const turn = text => ask(post('/api/ask', { action: 'turn', id: randomUUID(), text, history: [] }, headers), ctx);
  const first = await (await turn(address)).json();
  assert.equal(first.provider, 'jose');
  assert.equal(first.timings.modelMs, 0);
  const next = await (await turn('when did we send it?')).json();
  assert.equal(next.provider, 'jose');
  assert.deepEqual(calls[1].args, { view: 'sent', jobId: id });
});

test('standalone browser resolves the address under a configured Desk operator, with its own chat history', async () => {
  const calls = [];
  const store = memoryAdapter();
  const standalone = { ...env, DASHBOARD_KEY: 'a2z-dashboard-test-key', ESTIMATING_DASHBOARD_USER_ID: 'first' };
  const handler = createJarvisHandler({ env: standalone, openStore: async () => store,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return Response.json({ ...record, facts: [stage] });
    } });
  const send = (prompt, threadId, headers) => handler(post('/api/jarvis',
    { role: 'main', prompt, ...(threadId ? { threadId } : { newThread: true }) }, headers));
  const first = await (await send('What is the status of our AutoZone bid?')).json();
  assert.equal(calls[0].actor, 'first');
  assert.equal(calls[0].args.query, 'AutoZone');
  await send('it’s ' + address, first.threadId);
  assert.equal(calls[1].args.query, address);
  await send('when did we send it?', first.threadId);
  assert.equal(calls[2].args.jobId, id);
  const personal = await send('when did we send it?', first.threadId, signIn('first'));
  assert.equal(personal.status, 404);
  assert.equal((await send(address, null, { 'x-a2z-key': 'wrong' })).status, 401);
  assert.equal(calls.length, 3);
});
