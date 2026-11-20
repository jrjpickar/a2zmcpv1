import { randomUUID } from 'node:crypto';
import { update } from './jarvis-memory.mjs';

export const diagnosticKey = 'diagnostics/jarvis-models';
export const emptyDiagnostics = () => ({ models: {}, events: [], active: null });
const transient = new Set([429, 502, 503, 504]);
const minimumProbeDelay = 30000;
const validModel = value => typeof value === 'string' && /^[a-z0-9._/-]{1,100}$/i.test(value);
const retryAfter = (value, now) => {
  if (!value) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Math.max(0, Number.isFinite(delay) ? delay : 0);
};

// Retain recognizable provider errors. Unknown messages may contain echoed input.
const providerMessages = /^(?:bad gateway|service unavailable|gateway timeout|internal server error|rate limit (?:reached|exceeded)|too many requests|server error|model overloaded|invalid api key)[.!]?$/i;
async function responseError(response) {
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    while (size <= 8192) {
      const { done, value } = await reader.read();
      if (done) {
        const error = JSON.parse(body + decoder.decode()).error;
        const code = /^[a-z][a-z_]{1,45}$/.test(error?.code || '') ? error.code : undefined;
        const message = typeof error?.message === 'string' && providerMessages.test(error.message.trim())
          ? error.message.trim() : 'Provider message withheld';
        return { code, message };
      }
      size += value.byteLength;
      if (size <= 8192) body += decoder.decode(value, { stream: true });
    }
  } catch { /* Upstream response may be HTML or non-JSON. */ }
  finally { void reader.cancel().catch(() => {}); }
  return {};
}

export function createGroqFailover({
  primary, backup, openStore, fetchImpl = fetch, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), jitter = () => Math.random() * 250,
  deadlineMs = 20000, attemptMs = 4500,
}) {
  const secondary = validModel(backup) && primary !== backup ? backup : null;
  const models = new Map();
  let pendingProbe = false, cachedUntil = 0, loading;

  async function hydrate() {
    if (!openStore || now() < cachedUntil) return;
    loading ||= (async () => {
      try {
        const record = (await (await openStore()).getWithMetadata(diagnosticKey, { type: 'json' }))?.data;
        for (const [model, snapshot] of Object.entries(record?.models || {})) {
          if (model !== primary && model !== secondary) continue;
          if (!models.has(model) || snapshot.at > models.get(model).at) models.set(model, snapshot);
        }
      } catch { /* Diagnostics must never prevent inference. */ }
      finally { cachedUntil = now() + 5000; loading = null; }
    })();
    await loading;
  }

  async function save(events, changes, active) {
    if (!openStore || (!events.length && !changes.size)) return;
    try {
      await update(await openStore(), diagnosticKey, emptyDiagnostics, record => {
        const configured = new Set([primary, secondary].filter(Boolean));
        record.models = Object.fromEntries(Object.entries(record.models).filter(([model]) => configured.has(model)));
        for (const [model, value] of changes) {
          if (!record.models[model] || value.at >= record.models[model].at) record.models[model] = value;
        }
        if (active && (!record.active || active.at >= record.active.at)) record.active = active;
        record.events = [...record.events, ...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
      });
    } catch { /* A storage failure does not change the provider response. */ }
  }

  return async (url, init) => {
    const started = now(), requestId = randomUUID(), events = [], changes = new Map();
    let active, lastResponse, lastError;
    const original = JSON.parse(init.body);
    const record = (type, model, fields = {}) => events.push({
      type, requestId, provider: 'Groq', source: 'Groq', model, at: new Date(now()).toISOString(),
      elapsedMs: now() - started, ...fields,
    });
    const status = (model, state, until = 0) => {
      const value = { state, until, at: now() };
      models.set(model, value); changes.set(model, value);
    };
    await hydrate();
    const prior = models.get(primary);
    const probe = secondary && ['down', 'checking'].includes(prior?.state) && prior.until <= now() && !pendingProbe;
    const skipPrimary = secondary && ((prior?.state === 'down' && !probe) || (prior?.state === 'checking' && prior.until > now()));
    if (probe) {
      pendingProbe = true;
      status(primary, 'checking', now() + minimumProbeDelay);
      record('probe', primary);
      await save(events.splice(0), changes, null);
    }
    const candidates = skipPrimary ? [secondary] : [primary, secondary].filter(Boolean);
    try {
      for (const model of candidates) {
        if (model === secondary && (models.get(model)?.until || 0) > now()) continue;
        if (model === secondary) record('failover', primary, { destination: secondary });
        const retries = model === primary && secondary && !probe ? 3 : 0;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const reserve = model === primary && secondary ? 3000 : 0;
          const remaining = deadlineMs - (now() - started) - reserve;
          if (remaining <= 0) { status(model, 'down', now() + minimumProbeDelay); break; }
          if (lastResponse) { void lastResponse.body?.cancel().catch(() => {}); lastResponse = null; }
          let response;
          let rateWait = 0;
          const before = now();
          try {
            const body = { ...original, model };
            if (!/^openai\/gpt-oss-/.test(model)) {
              delete body.reasoning_effort; delete body.include_reasoning;
            }
            response = await fetchImpl(url, {
              ...init, body: JSON.stringify(body),
              signal: AbortSignal.timeout(Math.max(1, Math.min(secondary ? attemptMs : deadlineMs, remaining))),
            });
            lastResponse = response;
          } catch (error) {
            lastError = error;
            record('error', model, { retry: attempt, durationMs: now() - before,
              message: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Provider request timed out' : 'Provider connection failed' });
          }
          if (response?.ok) {
            active = { model, provider: 'Groq', at: now() };
            if (model === primary && (probe || prior?.state === 'down' || prior?.state === 'checking')) record('recovery', model);
            if (models.get(model)?.state !== 'ok') status(model, 'ok');
            return response;
          }
          if (response) {
            rateWait = response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : 0;
            record('error', model, { httpStatus: response.status, retry: attempt, durationMs: now() - before,
              ...(await responseError(response)), ...(rateWait ? { retryAfterMs: rateWait } : {}) });
            if (!transient.has(response.status)) {
              status(model, 'rejected');
              return response;
            }
          }
          const delay = Math.max(rateWait, 1000 * 2 ** attempt + jitter());
          if (attempt < retries && now() - started + delay + reserve + 100 < deadlineMs) {
            await wait(delay);
          } else {
            status(model, 'down', now() + Math.max(minimumProbeDelay, rateWait));
            break;
          }
        }
      }
      if (lastResponse) return lastResponse;
      if (lastError) throw lastError;
      return new Response(null, { status: 503 });
    } finally {
      if (probe) pendingProbe = false;
      // Persist the successful destination even when its breaker already says healthy.
      if (active && (events.length || changes.size)) changes.set(active.model, models.get(active.model));
      await save(events, changes, active);
    }
  };
}
