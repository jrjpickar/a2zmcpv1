import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createMemory, historyFor, memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { routeIntent } from '../netlify/functions/lib/jarvis-agents.mjs';
import { env, fakeGroq, plan, post } from './jarvis-helpers.mjs';

const report = { range: { from: '2026-11-01', to: '2026-11-18' }, funnel: { leads: 18, proposals: 7, wins: 4 } };
const mailbox = { syncedAt: '2026-11-18T16:00:00Z', stats: { unreadIncoming: 3 }, messages: [{ subject: 'Bid invitation', receivedAt: '2026-11-18T15:00:00Z', text: 'Due Friday' }] };
const noStore = () => { throw new Error('storage must not be opened'); };
const call = (run, body, headers) => run(post('/api/jarvis', body, headers));

test('JARVIS rejects missing key, foreign origin, wrong content type, bad role and GET', async () => {
  const run = createJarvisHandler({ env, fetchImpl: fakeGroq('x').fetchImpl, readSystems: async () => report, openStore: noStore });
  const body = { role: 'systems', prompt: 'How are wins?' };
  assert.equal((await call(run, body, { 'x-a2z-key': '' })).status, 401);
  assert.equal((await call(run, body, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(run, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call(run, { ...body, role: 'shell' })).status, 400);
  assert.equal((await call(run, { ...body, prompt: 'x'.repeat(1001) })).status, 400);
  assert.equal((await run(new Request('https://ops.a2z.test/api/jarvis'))).status, 405);
  assert.equal((await createJarvisHandler({ env: { DASHBOARD_KEY: env.DASHBOARD_KEY }, openStore: noStore })(post('/api/jarvis', body))).status, 503);
});

test('stateless systems call uses gpt-oss-20b once, sends aggregates, opens no storage and reports token usage', async () => {
  const groq = fakeGroq('Wins are 4.');
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async preset => ({ ...report, preset }), openStore: noStore });
  const data = await (await call(run, { role: 'systems', prompt: 'How are wins?', preset: 'wtd' })).json();
  assert.equal(data.answer, 'Wins are 4.');
  assert.deepEqual(data.trace, ['systems']);
  assert.deepEqual(data.usage, { totalTokens: 100, calls: 1 });
  assert.equal(data.threadId, undefined);
  const sent = groq.calls[0];
  assert.equal(sent.model, 'openai/gpt-oss-20b');
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.include_reasoning, false);
  assert.equal(sent.messages.length, 2, 'no history in a stateless call');
  assert.equal(JSON.parse(sent.messages[1].content).report.preset, 'wtd');
  assert.ok(!/[\u2013\u2014]/.test(sent.messages[0].content));
});

test('main delegates by keyword without a classifier call, and uses the classifier when ambiguous', async () => {
  assert.equal(routeIntent('Any unread emails from GCs?'), 'email');
  assert.equal(routeIntent('Build a view of wins by pipeline'), 'build');
  assert.equal(routeIntent('Hello there'), null);
  let groq = fakeGroq('You have 1 bid invitation due Friday.');
  let run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readMail: async () => mailbox, openStore: async () => memoryAdapter() });
  let data = await (await call(run, { role: 'main', prompt: 'Any unread emails I should answer?' })).json();
  assert.deepEqual(data.trace, ['main', 'email']);
  assert.equal(data.agent, 'email');
  assert.equal(groq.calls.length, 1);
  assert.equal(JSON.parse(groq.calls[0].messages[1].content).mailbox.messages[0].subject, 'Bid invitation');

  groq = fakeGroq({ agent: 'systems' }, 'Here is the overview.');
  run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() });
  data = await (await call(run, { role: 'main', prompt: 'What should I focus on today?' })).json();
  assert.deepEqual(data.trace, ['main', 'systems']);
  assert.equal(groq.calls[0].response_format.type, 'json_object');
  assert.deepEqual(data.usage, { totalTokens: 200, calls: 2 });

  groq = fakeGroq({ agent: 'main', answer: 'Hi Jesse. Ask about email, KPIs or a dashboard change.' });
  run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, openStore: async () => memoryAdapter() });
  data = await (await call(run, { role: 'main', prompt: 'hey' })).json();
  assert.deepEqual(data.trace, ['main']);

  groq = fakeGroq({ agent: 'rm -rf' });
  run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, openStore: async () => memoryAdapter() });
  assert.equal((await call(run, { role: 'main', prompt: 'hey' })).status, 502);
});

test('Development returns a validated plan only when automatic QC approves, and QC never sees the builder playbook', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  await memory.addLesson('build', 'Always name views with a _v suffix');
  await memory.addShared('Labor rate is 65 dollars per hour');
  for (const approved of [true, false]) {
    const groq = fakeGroq({ summary: 'View plus binding.', plan }, (body) => {
      assert.match(body.messages[0].content, /independent A2Z QC/);
      assert.ok(!body.messages[0].content.includes('_v suffix'), 'automatic QC does not see the Development playbook');
      assert.match(body.messages[0].content, /Labor rate is 65/, 'shared company memory reaches QC');
      return { approved, findings: approved ? 'Meets the request.' : 'Missing a check on empty pipelines.' };
    });
    const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, openStore: async () => store });
    const data = await (await call(run, { role: 'build', prompt: 'Build a wins by pipeline view', newThread: true })).json();
    assert.match(groq.calls[0].messages[0].content, /_v suffix/, 'Development sees its own lessons');
    assert.deepEqual(data.trace, ['build', 'qc']);
    assert.equal(data.approved, approved);
    assert.equal(data.buildSummary, 'View plus binding.');
    if (approved) {
      assert.match(data.planHash, /^[0-9a-f]{64}$/);
      assert.equal(data.plan.steps[1].module, 'pipelines');
    } else {
      assert.equal(data.plan, undefined);
    }
  }
  const learned = await memory.getMemory('build');
  assert.equal(learned.qcFindings[0].text, 'Missing a check on empty pipelines.');
  assert.equal(learned.stats.qcPass, 1);
  assert.equal(learned.stats.qcFail, 1);
  // QC rejections feed the next Development prompt.
  const groq = fakeGroq({ summary: 'Need detail.', plan: null });
  await call(createJarvisHandler({ env, fetchImpl: groq.fetchImpl, openStore: async () => store }), { role: 'build', prompt: 'Another view', newThread: true });
  assert.match(groq.calls[0].messages[0].content, /Recent QC rejections[\s\S]*empty pipelines/);
});

test('an invalid Development plan is rejected before QC', async () => {
  const groq = fakeGroq({ summary: 'Drop it.', plan: { task: 'x', steps: [{ action: 'Run Query', sql: 'DROP TABLE funnel' }] } });
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, openStore: noStore });
  const response = await call(run, { role: 'build', prompt: 'Build something' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /unsupported plan/);
  assert.equal(groq.calls.length, 1);
});

test('chat mode saves the thread, injects the last turns as messages, lessons, exemplars and shared memory', async () => {
  const store = memoryAdapter();
  const groq = fakeGroq((body, n) => 'Reply ' + n);
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => store });
  const first = await (await call(run, { role: 'systems', prompt: 'How are wins this month?', newThread: true })).json();
  assert.ok(first.threadId && first.messageId);
  assert.equal(first.title, 'How are wins this month?');

  const saved = await (await call(run, { role: 'systems', prompt: 'remember: lead with the runway', threadId: first.threadId })).json();
  assert.match(saved.answer, /Saved/);
  assert.equal(groq.calls.length, 1, 'remember costs no Groq call');
  const all = await (await call(run, { role: 'systems', prompt: 'remember for all agents: crews are 6 laborers plus a foreman', threadId: first.threadId })).json();
  assert.equal(all.shared, true);

  // Rate the first reply helpful so it becomes an approved example.
  const memory = createMemory(store);
  await memory.feedback('systems', first.threadId, first.messageId, 1);

  await call(run, { role: 'systems', prompt: 'And how are wins compared to last month?', threadId: first.threadId });
  const sent = groq.calls[1];
  const system = sent.messages[0].content;
  assert.match(system, /lead with the runway/);
  assert.match(system, /crews are 6 laborers/);
  assert.match(system, /approved for similar requests[\s\S]*How are wins this month/);
  const history = sent.messages.slice(1, -1);
  assert.equal(history.length, 6, 'last 6 messages sent as chat turns');
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(history[0].content, 'How are wins this month?');

  // Shared memory reaches every agent, including email.
  const mail = fakeGroq('ok');
  await call(createJarvisHandler({ env, fetchImpl: mail.fetchImpl, readMail: async () => mailbox, openStore: async () => store }), { role: 'email', prompt: 'Summarize', newThread: true });
  assert.match(mail.calls[0].messages[0].content, /crews are 6 laborers/);

  const thread = await memory.getThread('systems', first.threadId);
  assert.equal(thread.messages.length, 8);
  assert.equal((await call(run, { role: 'systems', prompt: 'x', threadId: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('history is trimmed by the character budget as well as the turn count', () => {
  const thread = { messages: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(1200) })) };
  assert.equal(historyFor(thread).length, 5, '6 x 1200 exceeds 6000, so the oldest is dropped');
  assert.equal(historyFor(thread, 2500).length, 2);
  assert.equal(historyFor(thread, 100000).length, 6);
  assert.equal(historyFor(thread)[4].content[0], '9');
});

test('storage failure returns 503 in chat mode while stateless calls still work', async () => {
  const groq = fakeGroq('ok');
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => { throw new Error('down'); } });
  assert.equal((await call(run, { role: 'systems', prompt: 'x', newThread: true })).status, 503);
  assert.equal((await call(run, { role: 'bot-estimator', prompt: 'x' })).status, 503);
  assert.equal((await call(run, { role: 'systems', prompt: 'x' })).status, 200);
});

test('/execute validates a plan in chat without a Groq call', async () => {
  const store = memoryAdapter();
  const groq = fakeGroq('unused');
  const run = createJarvisHandler({ env: { DASHBOARD_KEY: env.DASHBOARD_KEY }, fetchImpl: groq.fetchImpl, openStore: async () => store });
  const data = await (await call(run, { role: 'main', prompt: '/execute ' + JSON.stringify({ ...plan, report: { dials: 1 } }), newThread: true })).json();
  assert.equal(data.validation.ok, true);
  assert.match(data.validation.warnings[0], /report field was ignored/);
  assert.match(data.planHash, /^[0-9a-f]{64}$/);
  assert.equal(data.title, 'Execute: Wins by pipeline');
  const bad = await (await call(run, { role: 'main', prompt: '/execute {"task":"x","steps":[{"action":"Run Query","sql":"DELETE FROM funnel"}]}', newThread: true })).json();
  assert.equal(bad.validation.ok, false);
  assert.equal(bad.planHash, undefined);
  assert.equal(groq.calls.length, 0);
  assert.equal((await createMemory(store).getMemory('main')).stats.runs, 0, 'validation is not counted as an agent run');
});

test('custom bots run with their own instructions and selected data', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const bot = await memory.saveBot({ name: 'Bid Coach', description: 'Bid strategy', instructions: 'Coach the estimator on bid strategy.', context: 'metrics' });
  assert.equal(bot.id, 'bot-bid-coach');
  const groq = fakeGroq('Bid tighter.');
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => store });
  const data = await (await call(run, { role: 'bot-bid-coach', prompt: 'How do I win more?', newThread: true })).json();
  assert.deepEqual(data.trace, ['bot-bid-coach']);
  assert.match(groq.calls[0].messages[0].content, /Bid Coach[\s\S]*Coach the estimator/);
  assert.deepEqual(JSON.parse(groq.calls[0].messages.at(-1).content).report, report);
  assert.equal((await call(run, { role: 'bot-nobody', prompt: 'x' })).status, 404);
  // Main can delegate to a custom bot by name.
  const main = fakeGroq('Coaching.');
  const viaMain = await (await call(createJarvisHandler({ env, fetchImpl: main.fetchImpl, readSystems: async () => report, openStore: async () => store }), { role: 'main', prompt: 'Ask bid coach for help' })).json();
  assert.deepEqual(viaMain.trace, ['main', 'bot-bid-coach']);
});
