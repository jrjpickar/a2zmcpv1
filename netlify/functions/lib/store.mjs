// Shared Netlify Blobs store. Falls back to memory when Blobs is not available (local tests).
import { getStore } from '@netlify/blobs';

function memoryStore() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } };
}
let fallback = null;
export function appStore() {
  try { return getStore({ name: 'a2z-operations', consistency: 'strong' }); } catch { return (fallback ||= memoryStore()); }
}
export const SETTINGS_KEY = 'alerts/settings';
