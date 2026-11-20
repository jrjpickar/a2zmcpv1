import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroqFailover, diagnosticKey } from '../netlify/functions/lib/jarvis-failover.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import diagnostics, { diagnosticView } from '../netlify/functions/jarvis-diagnostics.mjs';

const success = () => Response.json({ choices: [{ message: { content: 'ok' } }] });
const bad = (status, headers) => Response.json({ error: { code: 'upstream_error', message: 'Bad gateway' } }, { status, headers });

function fixture(respond) {
  let time = Date.parse('2026-11-19T20:00:00Z');
  const store = memoryAdapter(), waits = [], requests = [];
  const setup = () => createGroqFailover({
    primary: 'openai/gpt-oss-20b', backup: 'openai/gpt-oss-120b', openStore: async () => store,
    now: () => time, jitter: () => 0, wait: async ms => { waits.push(ms); time += ms; },
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      time += 10;
      return respond(body);
    },
  });
  const body = { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'private fixture prompt' }], tools: [{ type: 'function' }] };
  const call = (route) => route('https://fixture.example', { body: JSON.stringify(body) });
  return { store, waits, requests, setup, call, advance: ms => { time += ms; }, body };
}
const view = async f => diagnosticView((await f.store.getWithMetadata(diagnosticKey)).data, 'openai/gpt-oss-20b', 'openai/gpt-oss-120b');

for (const status of [502, 503, 504]) {
  test('retry and fail over after HTTP ' + status, async () => {
    const f = fixture(({ model }) => model === 'openai/gpt-oss-20b' ? bad(status) : success());
    assert.equal((await f.call(f.setup())).status, 200);
    assert.deepEqual(f.waits, [1000, 2000, 4000]);
    for (const request of f.requests) assert.deepEqual({ ...request, model: f.body.model }, f.body);
    const diagnostics = await view(f);
    assert.equal(diagnostics.status, 'degraded');
    assert.equal(diagnostics.errors.length, 4);
    assert.equal(diagnostics.errors[0].message, 'Bad gateway');
    assert.ok(!JSON.stringify(diagnostics).includes('private fixture prompt'));
  });
}

test('429 honors Retry-After and recovery survives creating a new transport', async () => {
  let recover = false;
  const f = fixture(({ model }) => !recover && model === 'openai/gpt-oss-20b' ? bad(429, { 'Retry-After': '3' }) : success());
  assert.equal((await f.call(f.setup())).status, 200);
  assert.deepEqual(f.waits, [3000, 3000, 4000]);
  await f.call(f.setup());
  assert.equal(f.requests.at(-1).model, 'openai/gpt-oss-120b');
  recover = true;
  f.advance(30001);
  await f.call(f.setup());
  const data = await view(f);
  assert.equal(data.status, 'operational');
  assert.ok(data.events.some(event => event.type === 'recovery'));
});

test('timeouts switch to the backup, and the diagnostic endpoint shows both failures with admin authentication', async () => {
  const f = fixture(({ model }) => {
    if (model === 'openai/gpt-oss-20b') throw new DOMException('private detail', 'TimeoutError');
    return bad(503);
  });
  assert.equal((await f.call(f.setup())).status, 503);
  const env = { DASHBOARD_KEY: 'fixture-dashboard-key', JARVIS_GROQ_BACKUP_MODEL: 'openai/gpt-oss-120b' };
  const options = { env, openStore: async () => f.store };
  const url = 'https://fixture.example/api/jarvis-diagnostics';
  assert.equal((await diagnostics(new Request(url), options)).status, 401);
  const auth = new Request(url, { headers: { 'x-a2z-key': env.DASHBOARD_KEY } });
  for (let refresh = 0; refresh < 2; refresh++) {
    const data = await (await diagnostics(auth, options)).json();
    assert.equal(data.status, 'unavailable');
    assert.ok(data.errors.some(error => error.message === 'Provider request timed out'));
    assert.ok(!JSON.stringify(data).includes('private detail'));
  }
});

test('authentication and request errors stay on the primary with zero retries', async () => {
  for (const code of [400, 401, 403]) {
    const f = fixture(() => bad(code));
    assert.equal((await f.call(f.setup())).status, code);
    assert.equal(f.requests.length, 1);
  }
});

test('retries keep tool execution outside the model transport', async () => {
  const { groqModel } = await import('../netlify/functions/lib/jarvis-agents.mjs');
  const { mailActions } = await import('../netlify/functions/lib/jarvis-mail-actions.mjs');
  const f = fixture(({ model }) => model === 'openai/gpt-oss-20b' ? bad(502) : Response.json({
    choices: [{ message: { tool_calls: [{ type: 'function', function: {
      name: 'draft', arguments: JSON.stringify({ to: 'fixture@example.test', body: 'Example draft' }),
    } }] } }],
  }));
  let writes = 0;
  const actions = mailActions({
    env: { MCP_MAIL_DRAFT_TOKEN: 'fixture-draft-token' },
    fetchImpl: async (_, init) => {
      writes++;
      const { id } = JSON.parse(init.body);
      return Response.json({ id, status: 'draft_saved' });
    },
  });
  const answer = await actions({ model: groqModel('fixture-api-key', f.setup()), prompt: 'Draft an email' });
  assert.match(answer, /^Draft saved/);
  assert.equal(f.requests.length, 5);
  assert.equal(writes, 1);
});
