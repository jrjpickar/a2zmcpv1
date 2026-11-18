// Shared Netlify Blobs store. Falls back to memory when Blobs is not available (local tests).
import { getStore } from '@netlify/blobs';
import { localKeyedStore } from './local-store.mjs';

function memoryStore() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } };
}
// Docker/VM deploys set A2Z_STORE_DIR so alert settings persist on disk. Netlify deploys leave it unset.
function fileStore(directory) {
  const files = localKeyedStore(directory);
  return {
    async get(k) { return (await files.getWithMetadata(k))?.data ?? null; },
    async setJSON(k, v) { await files.setJSON(k, v, {}); },
  };
}
let fallback = null;
let disk = null;
export function appStore() {
  if (process.env.A2Z_STORE_DIR) return (disk ||= fileStore(process.env.A2Z_STORE_DIR));
  try { return getStore({ name: 'a2z-operations', consistency: 'strong' }); } catch { return (fallback ||= memoryStore()); }
}
export const SETTINGS_KEY = 'alerts/settings';
