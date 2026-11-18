// JARVIS execution sandbox. Admin dashboard access, same origin and JSON required.
// POST { action: "validate", plan }            -> static checks and the plan hash. No SQL runs.
// POST { action: "run", plan, planHash, preset? } -> runs the validated plan on a throwaway copy of A2Z aggregates.
// GET                                           -> recent audit log.
// Nothing is applied to production. Set JARVIS_EXECUTE=off to disable the endpoint.
import { randomUUID } from 'node:crypto';
import { guard, readBody } from './lib/jarvis-http.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { update } from './lib/jarvis-memory.mjs';
import { runPlan, sandboxTables, validatePlan } from './lib/jarvis-sandbox.mjs';
import { report } from './lib/report.mjs';
import { PRESETS } from './lib/alerts.mjs';
import { json } from './lib/http.mjs';

export const LOG_KEY = 'exec/log';
const emptyLog = () => ({ entries: [] });

export function createExecuteHandler({ env = process.env, openStore = () => openJarvisStore(env), readReport = preset => report({ preset }), run = runPlan } = {}) {
  let running = false;
  return async function handler(request) {
    const { access, response } = guard(request, { env, methods: ['GET', 'POST'] });
    if (response) return response;
    if (env.JARVIS_EXECUTE === 'off') return json({ error: 'Execution is disabled (JARVIS_EXECUTE=off).' }, 403);
    if (request.method === 'GET') {
      try {
        const entry = await (await openStore()).getWithMetadata(LOG_KEY, { type: 'json' });
        return json({ entries: (entry?.data?.entries || []).slice(0, 20) });
      } catch {
        return json({ error: 'JARVIS storage is unavailable.' }, 503);
      }
    }
    let body;
    try {
      body = await readBody(request, 16384);
      if (!['validate', 'run'].includes(body.action) || !PRESETS.includes(body.preset ?? 'mtd')) throw new TypeError();
      if (body.action === 'run' && (typeof body.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.planHash))) throw new TypeError();
    } catch (error) {
      return json({ error: error.status === 413 ? error.message : 'Invalid execution request.' }, error.status === 413 ? 413 : 400);
    }
    const checked = validatePlan(body.plan);
    const validation = { ok: checked.ok, errors: checked.errors, warnings: checked.warnings };
    if (body.action === 'validate') return json({ validation, plan: checked.ok ? checked.plan : null, planHash: checked.hash });
    if (!checked.ok) return json({ error: 'The plan failed validation.', validation }, 422);
    if (checked.hash !== body.planHash) return json({ error: 'The plan changed after validation. Validate it again before running.' }, 409);
    if (running) return json({ error: 'Another sandbox run is in progress. Retry shortly.' }, 429);
    running = true;
    const entry = { id: randomUUID(), at: new Date().toISOString(), by: access.userId || 'dashboard key', task: checked.plan.task, planHash: checked.hash, outcome: 'running' };
    let store;
    try {
      // Fail closed: no run without an audit record.
      try {
        store = await openStore();
        await update(store, LOG_KEY, emptyLog, log => { log.entries.unshift(entry); log.entries.length = Math.min(log.entries.length, 50); });
      } catch {
        return json({ error: 'JARVIS storage is unavailable, so the run was not started.' }, 503);
      }
      let result;
      try {
        result = await run(checked.plan, sandboxTables(await readReport(body.preset ?? 'mtd')));
      } catch (error) {
        result = { outcome: 'failed', applied: false, error: error.agentStatus ? error.message : 'The sandbox could not run this plan.', steps: [], checks: [], staged: [] };
      }
      await update(store, LOG_KEY, emptyLog, log => {
        const saved = log.entries.find(item => item.id === entry.id);
        if (!saved) return false;
        Object.assign(saved, { outcome: result.outcome, staged: result.staged.length, finishedAt: new Date().toISOString() });
      }).catch(() => {});
      return json({ runId: entry.id, validation, ...result });
    } finally {
      running = false;
    }
  };
}

export default createExecuteHandler();
export const config = { path: '/api/jarvis-execute' };
