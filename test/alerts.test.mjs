import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WEBHOOK, catalog, evaluate, loadSettings, runCheck, sanitize, saveSettings } from '../netlify/functions/lib/alerts.mjs';
import { report } from '../netlify/functions/lib/report.mjs';
import alertsApi from '../netlify/functions/alerts.mjs';

const now = new Date('2026-11-16T20:00:00Z');
const env = { DATA_MODE: 'sample', ALERT_ALLOW_SAMPLE: '1' };
const memory = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } }; };

test('catalog covers every metric family with the Make webhook as default', async () => {
  const keys = catalog(await report({}, env, now)).map(m => m.key);
  for (const k of ['leads', 'proposals', 'wins', 'labor', 'pipeline-total', 'pipeline:demo', 'workforce', 'runway', 'cash', 'twilio', 'make-credits', 'deploy:Ledger', 'source:ghl']) assert.ok(keys.includes(k), k);
  assert.equal((await loadSettings(memory())).webhookUrl, DEFAULT_WEBHOOK);
});

test('settings reject bad input', () => {
  assert.throws(() => sanitize({ webhookUrl: 'http://hook.test/x' }), RangeError);
  assert.throws(() => sanitize({ rules: { runway: { enabled: true, op: 'below' } } }), RangeError);
  assert.throws(() => sanitize({ cooldownMinutes: 1 }), RangeError);
  assert.deepEqual(sanitize({ rules: { 'source:ghl': { enabled: true, op: 'not_ok', threshold: 5 } } }).rules['source:ghl'], { enabled: true, op: 'not_ok', threshold: null, preset: 'mtd', wait: 1 });
});

test('triggered rules post once per cooldown and again after recovery', async () => {
  const store = memory(), posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('Accepted'); };
  await saveSettings({ cooldownMinutes: 60, rules: {
    runway: { enabled: true, op: 'below', threshold: 3 }, leads: { enabled: true, op: 'above', threshold: 1000, preset: 'today' },
    workforce: { enabled: false, op: 'below', threshold: 100 },
  } }, store);
  const first = await runCheck({ env, now, store, fetchImpl });
  assert.deepEqual(first, { triggered: 1, sent: 1, waiting: 0, fixed: 0 });
  assert.equal(posts[0].url, DEFAULT_WEBHOOK);
  assert.equal(posts[0].body.event, 'alert.triggered');
  assert.equal(posts[0].body.alerts[0].id, 'runway');
  assert.match(posts[0].body.alerts[0].message, /below 3: now 2\.8/);
  assert.ok(!/[–—]/.test(posts[0].body.summary));
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 30 * 60000), store, fetchImpl }), { triggered: 1, sent: 0, waiting: 0, fixed: 0 });
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 61 * 60000), store, fetchImpl }), { triggered: 1, sent: 1, waiting: 0, fixed: 0 });
  assert.match((await runCheck({ env: { DATA_MODE: 'sample' }, now, store, fetchImpl })).skipped, /Sample/);
});

test('status rules fire on unhealthy feeds and number rules ignore missing data', async () => {
  const settings = sanitize({ rules: { 'source:ghl': { enabled: true, op: 'not_ok' }, labor: { enabled: true, op: 'below', threshold: 10 } } });
  const { alerts } = await evaluate(settings, { env: {}, now });
  assert.deepEqual(alerts.map(a => a.id), ['source:ghl']);
  assert.equal(alerts[0].severity, 'high');
});

test('API needs the dashboard key to change settings or send', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, { DATA_MODE: 'sample', DASHBOARD_KEY: 'dashboard-test-key' });
  const store = memory(), posts = [];
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); return new Response('ok'); };
  const call = (method, body, key) => alertsApi(new Request('https://a.test/api/alerts', { method, body: body && JSON.stringify(body),
    headers: key ? { 'x-a2z-key': key } : {} }), { store, fetchImpl });
  assert.equal((await call('PUT', { rules: {} })).status, 401);
  assert.equal((await call('POST', { action: 'test' })).status, 401);
  const view = await (await call('GET')).json();
  assert.equal(view.canEdit, false);
  assert.ok(view.metrics.some(m => m.key === 'runway' && m.valueText === '2.8'));
  assert.equal((await call('PUT', { webhookUrl: 'ftp://x' }, process.env.DASHBOARD_KEY)).status, 400);
  assert.equal((await call('PUT', { rules: { runway: { enabled: true, op: 'below', threshold: 5 } } }, process.env.DASHBOARD_KEY)).status, 200);
  assert.deepEqual(await (await call('POST', { action: 'test' }, process.env.DASHBOARD_KEY)).json(), { sent: 1 });
  assert.equal(posts[0].test, true);
  assert.equal(posts[0].alerts[0].id, 'runway');
});

test('wait holds an alert until it breaches that many checks in a row, then a fixed note follows recovery', async () => {
  const store = memory(), posts = [];
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); return new Response('ok'); };
  await saveSettings({ cooldownMinutes: 60, rules: { runway: { enabled: true, op: 'below', threshold: 3, wait: 2 } } }, store);
  assert.deepEqual(await runCheck({ env, now, store, fetchImpl }), { triggered: 1, sent: 0, waiting: 1, fixed: 0 });
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 15 * 60000), store, fetchImpl }), { triggered: 1, sent: 1, waiting: 0, fixed: 0 });
  assert.equal(posts.length, 1);
  // The rule stops breaching: one fixed note, sent once.
  await saveSettings({ cooldownMinutes: 60, rules: { runway: { enabled: true, op: 'below', threshold: 1, wait: 2 } } }, store);
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 30 * 60000), store, fetchImpl }), { triggered: 0, sent: 0, waiting: 0, fixed: 1 });
  assert.equal(posts[1].event, 'alert.resolved');
  assert.match(posts[1].summary, /^Fixed: Financial runway/);
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 45 * 60000), store, fetchImpl }), { triggered: 0, sent: 0, waiting: 0, fixed: 0 });
  assert.equal(posts.length, 2);
  // Uptime samples are kept for Diagnostics.
  assert.ok(Object.keys(await store.get('sources/history')).length > 0);
});

test('fixed notes can be turned off and old settings still load with wait 1', async () => {
  const store = memory(), posts = [];
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); return new Response('ok'); };
  await store.setJSON('alerts/settings', { webhookUrl: DEFAULT_WEBHOOK, enabled: true, cooldownMinutes: 60, rules: { runway: { enabled: true, op: 'below', threshold: 3, preset: 'mtd' } }, billing: {} });
  assert.equal((await loadSettings(store)).notifyRecovery, true);
  assert.deepEqual(await runCheck({ env, now, store, fetchImpl }), { triggered: 1, sent: 1, waiting: 0, fixed: 0 });
  await saveSettings({ cooldownMinutes: 60, notifyRecovery: false, rules: { runway: { enabled: true, op: 'below', threshold: 1 } } }, store);
  assert.deepEqual(await runCheck({ env, now: new Date(+now + 15 * 60000), store, fetchImpl }), { triggered: 0, sent: 0, waiting: 0, fixed: 0 });
  assert.equal(posts.length, 1);
  assert.throws(() => sanitize({ rules: { runway: { enabled: true, op: 'below', threshold: 3, wait: 20 } } }), RangeError);
});
