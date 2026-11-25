import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { supabaseStore } from './jarvis-store.mjs';

const commandKey = 'jose-relay:v1:command';
const statusKey = 'jose-relay:v1:status';
const commandLifetime = 120000;
const statusLifetime = 90000;

function relayStore(env, fetchImpl) {
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || !env.SUPABASE_SERVICE_ROLE_KEY ||
    (env.JOSE_TOKEN || '').length < 32) throw new Error('Invalid JOSE relay configuration');
  return supabaseStore({ url, key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl });
}

function signature(token, kind, payload) {
  return createHmac('sha256', token).update('a2z-jose-relay-v1:' + kind + ':' + payload).digest();
}

function seal(env, kind, data) {
  const payload = JSON.stringify(data);
  return { payload, signature: signature(env.JOSE_TOKEN, kind, payload).toString('hex') };
}

function unseal(env, kind, record) {
  if (typeof record?.payload !== 'string' || !/^[a-f0-9]{64}$/.test(record.signature || '')) return null;
  if (!timingSafeEqual(Buffer.from(record.signature, 'hex'),
    signature(env.JOSE_TOKEN, kind, record.payload))) return null;
  return JSON.parse(record.payload);
}

export async function readRelayStatus(env, fetchImpl) {
  const store = relayStore(env, fetchImpl);
  const row = await store.getWithMetadata(statusKey);
  const status = unseal(env, 'status', row?.data);
  return status && Date.now() - status.at < statusLifetime ? status.value : null;
}

export async function enqueueRelay(input, env, fetchImpl) {
  const store = relayStore(env, fetchImpl);
  if (!await readRelayStatus(env, fetchImpl)) return { code: 503 };
  const row = await store.getWithMetadata(commandKey);
  const current = unseal(env, 'command', row?.data);
  const now = Date.now();
  if (current?.expires > now) return { code: 409 };
  const condition = row ? { onlyIfMatch: row.etag } : { onlyIfNew: true };
  const id = randomUUID();
  const result = await store.setJSON(commandKey, seal(env, 'command', {
    id, expires: now + commandLifetime, input,
  }), condition);
  return result.modified ? { code: 202, id } : { code: 409 };
}

export function createRelayWorker(env, runtime, fetchImpl = fetch) {
  const store = relayStore(env, fetchImpl);
  let busy = false;
  let published = 0;
  let previous = '';
  return async function poll() {
    if (busy) return;
    busy = true;
    try {
      const row = await store.getWithMetadata(commandKey);
      const current = unseal(env, 'command', row?.data);
      if (current && typeof current.id === 'string' && current.expires > Date.now()) {
        runtime.applyRelayCommand(current.id, current.input);
        // Publish before freeing the slot so an accepted action is visible to the next request.
        await publish();
        await store.setJSON(commandKey, {}, { onlyIfMatch: row.etag });
      } else {
        await publish();
      }
    } finally { busy = false; }
  };

  async function publish() {
    const value = runtime.status();
    const fingerprint = JSON.stringify([value.stopped, value.tasks, value.events, value.tools,
      value.monitors, value.providers, value.gateway, value.configError, value.relayReceipt]);
    const now = Date.now();
    if (fingerprint === previous && now - published < 30000) return;
    await store.setJSON(statusKey, seal(env, 'status', { at: now, value }));
    previous = fingerprint;
    published = now;
  }
}
