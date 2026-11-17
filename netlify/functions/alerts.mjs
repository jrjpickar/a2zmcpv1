import { dashboardAccess } from './lib/dashboard-auth.mjs';
import { json } from './lib/http.mjs';
import { alertStore, evaluate, loadSettings, payload, post, runCheck, saveSettings } from './lib/alerts.mjs';

// GET: settings, metric catalog and what is triggered now. PUT: save settings. POST: { action: 'test' | 'check' }.
export default async (request, { store = alertStore(), fetchImpl = fetch } = {}) => {
  const env = process.env;
  const access = dashboardAccess(request, env);
  if (access && !access.admin) return json({ error: 'Administrator access required' }, 403);
  const keyed = Boolean(access);
  if (!keyed && !(request.method === 'GET' && env.DATA_MODE === 'sample')) return json({ error: 'Dashboard key required' }, 401);
  try {
    if (request.method === 'GET') {
      const settings = await loadSettings(store);
      const { alerts, metrics } = await evaluate(settings, { env });
      return json({ settings, alerts, metrics: metrics.map(({ format, ...m }) => ({ ...m, valueText: m.kind === 'status' ? m.value : format(m.value) })), canEdit: keyed });
    }
    const body = await request.text();
    if (body.length > 32000) return json({ error: 'Payload too large' }, 413);
    const input = JSON.parse(body || '{}');
    if (request.method === 'PUT') return json({ settings: await saveSettings(input, store) });
    if (request.method === 'POST' && input.action === 'test') {
      const settings = await loadSettings(store);
      const { alerts, mode } = await evaluate(settings, { env });
      const sample = alerts.length ? alerts : [{ id: 'test', metric: 'Test alert', group: 'Test', district: 'system', condition: 'test', threshold: null,
        value: null, valueText: 'n/a', period: null, range: null, severity: 'low', message: 'Test alert from A2Z Operations. No rules are triggered right now.' }];
      await post(settings.webhookUrl, payload(sample, { mode, test: true, env }), fetchImpl);
      return json({ sent: sample.length });
    }
    if (request.method === 'POST' && input.action === 'check') return json(await runCheck({ env, store, fetchImpl, force: true }));
    return json({ error: 'Unsupported request' }, 405, { Allow: 'GET, PUT, POST' });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return json({ error: error.message }, 400);
    if (/^Webhook HTTP/.test(error.message)) return json({ error: error.message }, 502);
    console.error('Alerts request failed', error);
    return json({ error: 'Alerts unavailable' }, 500);
  }
};
export const config = { path: '/api/alerts' };
