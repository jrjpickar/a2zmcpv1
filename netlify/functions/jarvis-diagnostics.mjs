import { guard } from './lib/jarvis-http.mjs';
import { json } from './lib/http.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { emptyDiagnostics, diagnosticKey } from './lib/jarvis-failover.mjs';
import { JARVIS_MODEL } from './lib/jarvis-agents.mjs';
import { MODEL_LOG_KEY, usageSummary } from './lib/model-log.mjs';

export function diagnosticView(data, primary, configuredBackup) {
  const backup = configuredBackup && configuredBackup !== primary ? configuredBackup : null;
  const models = Object.fromEntries([primary, backup].filter(Boolean).map(model => [
    model, data.models[model] || { state: 'unknown' },
  ]));
  const main = models[primary].state;
  const secondary = backup && models[backup].state;
  const failed = state => state === 'down' || state === 'rejected';
  const status = main === 'checking' ? 'checking'
    : main === 'ok' ? 'operational'
    : failed(main) && secondary === 'ok' ? 'degraded'
    : failed(main) && (!backup || failed(secondary)) ? 'unavailable' : 'unknown';
  return {
    status, primary, backup, models,
    active: models[data.active?.model]?.state === 'ok' ? data.active : null,
    events: data.events.filter(event => Object.hasOwn(models, event.model)).slice(0, 50),
    errors: data.events.filter(event => event.type === 'error' && Object.hasOwn(models, event.model)).slice(0, 50),
  };
}

export default async function diagnostics(request, options = {}) {
  const { env = process.env, openStore = () => openJarvisStore(env) } = options;
  const { response } = guard(request, { env, methods: ['GET'] });
  if (response) return response;
  try {
    const store = await openStore();
    const data = (await store.getWithMetadata(diagnosticKey, { type: 'json' }))?.data || emptyDiagnostics();
    const view = diagnosticView(data, env.JARVIS_GROQ_MODEL?.trim() || JARVIS_MODEL, env.JARVIS_GROQ_BACKUP_MODEL?.trim());
    // Model usage is optional: a missing or unreadable log never hides the failover view.
    const log = await store.getWithMetadata(MODEL_LOG_KEY, { type: 'json' }).then(entry => entry?.data).catch(() => null);
    return json({ ...view, usage: usageSummary(log) });
  } catch {
    return json({ error: 'JARVIS diagnostics storage is unavailable.' }, 503);
  }
}
export const config = { path: '/api/jarvis-diagnostics' };
