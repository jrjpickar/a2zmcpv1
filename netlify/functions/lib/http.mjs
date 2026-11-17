import { timingSafeEqual } from 'node:crypto';

export function authorized(request, key, header) {
  const expected = Buffer.from(key || '');
  const supplied = Buffer.from(header === 'authorization'
    ? /^Bearer (.+)$/i.exec(request.headers.get(header) || '')?.[1] || ''
    : request.headers.get(header) || '');
  return expected.length >= 16 && supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers },
});

export class MissingConfiguration extends Error {}
// An error whose message is safe to show on the dashboard (no secrets, no upstream bodies).
export class ExposedError extends Error {}
export function required(env, key) {
  if (!env[key]?.trim()) throw new MissingConfiguration(key + ' is required');
  return env[key].trim();
}

export async function readJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(7500), ...options, redirect: 'error' });
  if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
  return response.json();
}

export function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
