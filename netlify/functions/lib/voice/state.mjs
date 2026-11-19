import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { marketplaceIdentity } from '../dashboard-auth.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');
export const issueKey = /^[\w-]{43}$/;
export const fault = (status, message) => Object.assign(new Error(message), { status });
export const limit = (env, name, fallback, ceiling) => {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
};
export const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function origin(env) {
  const url = new URL(env.VOICE_ORIGIN);
  if (url.href !== url.origin + '/' || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid VOICE_ORIGIN');
  return url.origin;
}

export function linkedIdentity(env, slackId) {
  const links = JSON.parse(env.VOICE_SLACK_LINKS || '{}');
  const userId = Object.hasOwn(links, slackId) ? links[slackId] : null;
  return marketplaceIdentity({ userId, companyId: env.GHL_MARKETPLACE_COMPANY_ID, activeLocation: env.GHL_LOCATION_ID }, env);
}

export function signLaunch(env, payload) {
  return createHmac('sha256', env.SLACK_SIGNING_SECRET).update('a2z-voice-launch-v1.' + payload).digest();
}

export function memoryStore() {
  const entries = new Map();
  let sweepAfter = 0;
  function current(key, now) {
    const record = entries.get(key);
    if (record && record.expires <= now) {
      entries.delete(key);
      return null;
    }
    return record ?? null;
  }
  return {
    async getWithMetadata(key) {
      const record = current(key, Date.now());
      return record ? { data: structuredClone(record.data), etag: record.etag } : null;
    },
    async setJSON(key, data, options) {
      const now = Date.now();
      if (now >= sweepAfter) {
        for (const id of entries.keys()) current(id, now);
        sweepAfter = now + 60000;
      }
      const old = current(key, now);
      if (options.onlyIfNew ? old : old?.etag !== options.onlyIfMatch) return { modified: false };
      if (!old && entries.size >= 4096) throw fault(503, 'Voice storage is busy. Try again.');
      const expires = key.startsWith('session/') ? data.expires : now + (key.startsWith('quota/') ? 2 * 86400000 : 120000);
      entries.set(key, { data: structuredClone(data), etag: nonce(), expires });
      return { modified: true };
    },
  };
}
let local;
export function stateStore(env) {
  if (env.VOICE_LOCAL_MEMORY === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin(env))) {
    return local ||= memoryStore();
  }
  return getStore({ name: 'a2z-voice', consistency: 'strong' });
}

export async function update(store, key, mutate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const old = await store.getWithMetadata(key, { type: 'json' });
    const value = mutate(old?.data);
    if ((await store.setJSON(key, value, old ? { onlyIfMatch: old.etag } : { onlyIfNew: true })).modified) return value;
  }
  throw fault(503, 'Voice storage is busy. Try again.');
}

export async function charge(store, env, kind) {
  const isTurn = kind === 'turn';
  const maximum = isTurn ? limit(env, 'VOICE_DAILY_TURNS', 100, 10000) : limit(env, 'VOICE_DAILY_SESSIONS', 50, 2000);
  const day = new Date().toISOString().slice(0, 10);
  return update(store, 'quota/' + day + '/' + kind, (count = 0) => {
    if (count >= maximum) throw fault(429, 'Daily voice usage limit reached.');
    return count + 1;
  });
}
