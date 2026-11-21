import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson } from '../netlify/functions/lib/http.mjs';
import { modelLogger, MODEL_LOG_KEY, usageSummary } from '../netlify/functions/lib/model-log.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { addSamples, sourceState } from '../netlify/functions/lib/source-history.mjs';

const fast = { maxAttempts: 3, initialIntervalMs: 1, backoffCoefficient: 2, maximumIntervalMs: 5, attemptTimeoutMs: 200 };

test('GET retries 5xx, 429 and network errors, then succeeds', async () => {
  const replies = [new Response('', { status: 503 }), new Response('', { status: 429, headers: { 'retry-after': '0' } }), Response.json({ ok: 1 })];
  let calls = 0;
  const data = await readJson('https://x.test/a', {}, { policy: fast, fetchImpl: async () => replies[calls++] });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls, 3);
  calls = 0;
  const flaky = async () => { if (calls++ === 0) throw new TypeError('fetch failed'); return Response.json({ ok: 2 }); };
  assert.deepEqual(await readJson('https://x.test/b', {}, { policy: fast, fetchImpl: flaky }), { ok: 2 });
});

test('no retry on 4xx, on POST, or past the caller budget', async () => {
  let calls = 0;
  await assert.rejects(readJson('https://x.test/a', {}, { policy: fast, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } }), /Upstream HTTP 401/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readJson('https://x.test/a', { method: 'POST' }, { policy: fast, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } }), /Upstream HTTP 503/);
  assert.equal(calls, 1);
  calls = 0;
  const hang = (url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers do not hold the event loop open.
  const started = Date.now();
  await assert.rejects(readJson('https://x.test/a', { signal: AbortSignal.timeout(50) }, { policy: { ...fast, attemptTimeoutMs: 5000 }, fetchImpl: hang }), { name: 'TimeoutError' });
  assert.ok(Date.now() - started < 1000, 'caller budget caps every try');
  clearInterval(keepAlive);
  assert.equal(calls, 1);
});

test('model log records calls without blocking or failing the reply', async () => {
  const store = memoryAdapter();
  const log = modelLogger({ openStore: async () => store });
  const fetchImpl = log.wrap(async url => String(url).includes('groq')
    ? Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    : new Response('', { status: 500 }));
  const body = JSON.stringify({ model: 'openai/gpt-oss-20b' });
  assert.equal((await fetchImpl('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', body })).status, 200);
  assert.equal((await fetchImpl('https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/x', { method: 'POST', body: '{}' })).status, 500);
  await fetchImpl('https://api.groq.com/openai/v1/models/x', { method: 'GET' }).catch(() => {});
  await log.flush();
  const saved = (await store.getWithMetadata(MODEL_LOG_KEY)).data;
  assert.equal(saved.rows.length, 2, 'GET probes are not model calls');
  const summary = usageSummary(saved, saved.rows[0].day);
  assert.deepEqual(summary.today['openai/gpt-oss-20b'], { calls: 1, errors: 0, inTokens: 10, outTokens: 5, avgMs: summary.today['openai/gpt-oss-20b'].avgMs });
  assert.equal(summary.today['@cf/x'].errors, 1);
  // A broken store never breaks the call.
  const broken = modelLogger({ openStore: async () => { throw new Error('down'); } });
  assert.equal((await broken.wrap(async () => Response.json({}))('https://api.groq.com/x', { method: 'POST', body })).status, 200);
  await broken.flush();
});

test('source history gives state and 24 h uptime', () => {
  const at = i => new Date(Date.now() - (10 - i) * 60000).toISOString();
  let h = {};
  for (let i = 0; i < 4; i++) h = addSamples(h, { ghl: { status: i < 3 ? 'ok' : 'error', ms: 10 }, make: { status: 'setup' } }, at(i));
  assert.equal(h.make, undefined);
  assert.deepEqual(sourceState(h.ghl, 1), { state: 'down', misses: 1, uptime24h: 75, checks24h: 4 });
  assert.equal(sourceState(h.ghl, 3).state, 'pending');
});
