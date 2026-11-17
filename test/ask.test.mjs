import assert from 'node:assert/strict';
import { test } from 'node:test';
import askApi from '../netlify/functions/ask.mjs';
import { report } from '../netlify/functions/lib/report.mjs';

test('HQ ask uses gpt-oss-120b on aggregates only and needs the dashboard key', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, { DATA_MODE: 'sample', DASHBOARD_KEY: 'dashboard-test-key', GROQ_API_KEY: 'gsk_test' });
  delete process.env.GROQ_MODEL;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return Response.json({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: '- Runway 2.8 months — watch burn' } }] });
  };
  const call = (body, key) => askApi(new Request('https://a.test/api/ask', { method: 'POST', body: JSON.stringify(body), headers: key ? { 'x-a2z-key': key } : {} }), { fetchImpl });
  assert.equal((await call({})).status, 401);
  const data = await (await call({}, process.env.DASHBOARD_KEY)).json();
  assert.equal(data.answer, '- Runway 2.8 months - watch burn');
  assert.ok(data.signals.length > 3);
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer gsk_test');
  assert.equal(sent.body.model, 'openai/gpt-oss-120b');
  assert.equal(sent.body.include_reasoning, false);
  assert.equal(sent.body.reasoning_effort, 'low');
  const prompt = sent.body.messages[1].content;
  assert.match(prompt, /signal-first overview/);
  assert.ok(!prompt.includes('Miguel Torres'), 'crew names stay out of the prompt');
  assert.ok(!/Multiple GCs/.test(prompt));
  await call({}, process.env.DASHBOARD_KEY);
  assert.equal(calls.length, 1, 'same question on the same data is cached');
  await call({ question: 'Which pipeline leads?' }, process.env.DASHBOARD_KEY);
  assert.equal(calls.length, 2);
  delete process.env.GROQ_API_KEY;
  assert.equal((await (await call({ question: 'x' }, process.env.DASHBOARD_KEY)).json()).configured, false);
});

test('signals rank urgent items first', async () => {
  const r = await report({}, { DATA_MODE: 'sample' }, new Date('2026-11-16T20:00:00Z'));
  assert.equal(r.signals[0].tone, 'watch');
  assert.ok(r.signals.some(s => s.area === 'workforce' && /available/.test(s.text)));
});
