import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../jose/runtime.mjs';
import proxy from '../netlify/functions/jose-runtime.mjs';

function fixture(t, models = [], options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jose-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { JOSE_TOKEN: 'j'.repeat(40), JOSE_STATE_DIR: dir, JOSE_CONFIG: join(dir, 'config.json'),
    JOSE_OPENROUTER_KEY: 'mock', JOSE_GROQ_FREE_KEY: 'mock', ...options };
  const configure = config => writeFileSync(env.JOSE_CONFIG, JSON.stringify(config));
  configure({ models });
  return { env, configure };
}
const route = (provider, model, rank = 0) =>
  ({ provider, model, rank, rpm: 10, rpd: 40, tpm: 3000, tpd: 10000, context: 4000 });
const task = { action: 'submit', profile: 'research', prompt: 'Analyze public material', publicData: true };
const success = () => Response.json({ choices: [{ message: { content: 'Result' } }], usage: { total_tokens: 45 } });

test('fails closed for paid models, billed accounts and missing public-data consent', async t => {
  const { env } = fixture(t, [route('openrouter', 'acme/paid'), route('groq', 'model')]);
  const runtime = createRuntime(env, () => assert.fail('inference called'));
  assert.equal(runtime.command({ ...task, publicData: false }), 400);
  assert.equal(runtime.command(task), 201);
  await runtime.tick();
  assert.equal(runtime.status().providers.length, 0);
  assert.equal(runtime.status().tasks[0].status, 'queued');
});

test('persists approval, uses one model per attempt, rotates at a rate limit', async t => {
  const { env } = fixture(t, [route('openrouter', 'acme/model:free'), route('groq', 'backup', 1)],
    { JOSE_GROQ_UNBILLED: 'yes' });
  const calls = [];
  const provider = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (url.includes('openrouter')) {
      assert.equal(body.provider.max_price.request, 0);
      assert.equal(body.provider.allow_fallbacks, false);
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
    }
    return success();
  };
  let runtime = createRuntime(env, provider);
  runtime.command({ ...task, approval: true });
  await runtime.tick();
  assert.equal(calls.length, 0);
  runtime = createRuntime(env, provider);
  const saved = runtime.status().tasks[0];
  assert.equal(saved.status, 'approval');
  runtime.command({ action: 'approve', id: saved.id });
  await runtime.tick();
  assert.equal(saved.status, 'queued');
  saved.nextAt = 0;
  await runtime.tick();
  assert.deepEqual(calls, ['acme/model:free', 'backup']);
  assert.equal(saved.tokens, 45);
  assert.equal(createRuntime(env).status().tasks[0].status, 'completed');
});

test('hot reload adds a route and honors local daily exhaustion', async t => {
  const { env, configure } = fixture(t);
  let calls = 0;
  const runtime = createRuntime(env, async () => { calls++; return success(); });
  runtime.command(task);
  await runtime.tick();
  assert.equal(calls, 0);
  configure({ models: [{ ...route('openrouter', 'acme/model:free'), rpd: 1 }] });
  await runtime.tick();
  runtime.command(task);
  await runtime.tick();
  assert.equal(calls, 1);
  assert.equal(runtime.status().tasks[0].status, 'queued');
});

test('MCP discovers with scoped credentials; emergency stop aborts and survives restart', async t => {
  const { env } = fixture(t, [route('openrouter', 'acme/model:free')],
    { JOSE_MCP_URL: 'https://mcp.example/mcp', JOSE_MCP_READ_TOKEN: 'scoped' });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const runtime = createRuntime(env, async (url, init) => {
    if (String(url).endsWith('/mcp')) {
      assert.equal(init.headers.authorization, 'Bearer scoped');
      assert.equal(JSON.parse(init.body).method, 'tools/list');
      return Response.json({ result: { tools: [{ name: 'report', inputSchema: { required: ['range'] } }] } });
    }
    ready();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  runtime.command(task);
  const tick = runtime.tick();
  await started;
  assert.deepEqual(runtime.status().tools.catalog[0].required, ['range']);
  assert.ok(runtime.status().events.some(event => event.type === 'MCP tool catalog updated'));
  runtime.command({ action: 'stop' });
  await tick;
  const recovered = createRuntime(env);
  assert.equal(recovered.status().stopped, true);
  assert.equal(recovered.status().tasks[0].status, 'queued');
});

test('authenticated proxy uses HTTPS and keeps upstream credentials server-side', async () => {
  const url = 'https://dashboard.example/api/jose-runtime';
  const env = { DASHBOARD_KEY: 'd'.repeat(20), JOSE_TOKEN: 'j'.repeat(40),
    JOSE_RUNTIME_URL: 'https://runtime.example/jose' };
  assert.equal((await proxy(new Request(url), { env })).status, 403);
  const authorized = new Request(url, { headers: { 'x-a2z-key': env.DASHBOARD_KEY } });
  const response = await proxy(authorized, { env, fetchImpl: async (target, init) => {
    assert.equal(String(target), env.JOSE_RUNTIME_URL);
    assert.equal(init.headers.authorization, 'Bearer ' + env.JOSE_TOKEN);
    assert.equal(init.redirect, 'error');
    return Response.json({ tasks: [] });
  } });
  assert.deepEqual(await response.json(), { tasks: [] });
});

test('tool catalog notices a changed contract and keeps the last snapshot on outage', async t => {
  const { env } = fixture(t, [], { JOSE_MCP_URL: 'https://mcp.example/mcp', JOSE_MCP_READ_TOKEN: 'scoped' });
  const reply = type => async () => Response.json({ result: { tools: [{
    name: 'report', description: 'Public test contract',
    inputSchema: { properties: { range: { type } }, required: ['range'] },
  }] } });
  let runtime = createRuntime(env, reply('string'));
  await runtime.tick();
  const original = runtime.status().tools.catalog[0].contract;
  runtime = createRuntime(env, reply('number'));
  await runtime.tick();
  const updated = runtime.status().tools.catalog[0].contract;
  assert.notEqual(updated, original);
  assert.equal(runtime.status().events.filter(event => event.type === 'MCP tool catalog updated').length, 2);
  runtime = createRuntime(env, async () => { throw new Error('unreachable'); });
  await runtime.tick();
  assert.equal(runtime.status().tools.status, 'unavailable');
  assert.equal(runtime.status().tools.catalog[0].contract, updated);
});

test('Supabase relay serializes submissions and deduplicates a replay after restart', async t => {
  const { env } = fixture(t, [], {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'mock',
  });
  const { createRelayWorker } = await import('../netlify/functions/lib/jose-relay.mjs');
  const rows = new Map();
  const fetchImpl = async (url, init) => {
    assert.equal(url.pathname, '/rest/v1/a2z_jarvis_kv');
    const key = url.searchParams.get('key')?.slice(3);
    if (!init.method) return Response.json(rows.has(key) ? [rows.get(key)] : []);
    const row = JSON.parse(init.body);
    if (init.method === 'PATCH') {
      if (rows.get(key)?.etag !== url.searchParams.get('etag')?.slice(3)) return Response.json([]);
      rows.set(key, row);
      return Response.json([row]);
    }
    if (!url.searchParams.has('on_conflict') && rows.has(row.key)) {
      return new Response(null, { status: 409 });
    }
    rows.set(row.key, row);
    return new Response(null, { status: 201 });
  };
  let runtime = createRuntime(env);
  const dashboard = { ...env, DASHBOARD_KEY: 'd'.repeat(20) };
  const api = input => proxy(new Request('https://dashboard.example/api/jose-runtime', {
    headers: { 'x-a2z-key': dashboard.DASHBOARD_KEY },
    ...(input && { method: 'POST', body: JSON.stringify(input) }),
  }), { env: dashboard, fetchImpl });
  let poll = createRelayWorker(env, runtime, fetchImpl);
  await poll();
  const responses = await Promise.all([api(task), api(task)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const key = 'jose-relay:v1:command';
  const pending = rows.get(key);
  await poll();
  assert.equal((await (await api()).json()).tasks.length, 1);
  rows.set(key, pending);
  runtime = createRuntime(env);
  poll = createRelayWorker(env, runtime, fetchImpl);
  await poll();
  assert.equal(runtime.status().tasks.length, 1);
  assert.equal((await (await api()).json()).relayReceipt.status, 201);
  rows.set(key, { ...pending, data: { ...pending.data, signature: '0'.repeat(64) } });
  await poll();
  assert.equal(runtime.status().tasks.length, 1);
});
