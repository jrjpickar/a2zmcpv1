// GET/POST /api/jarvis-instructions: custom instructions for every JARVIS agent (like ChatGPT or Claude).
// { about: what JARVIS should know about you, style: how JARVIS should respond }. Admin dashboard access, same origin, JSON.
// Saved in JARVIS storage (Supabase when configured). Applied to the dashboard, the city robots, Slack and all models.
import { guard, readBody } from './lib/jarvis-http.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { json } from './lib/http.mjs';

export const INSTRUCTIONS_KEY = 'settings/instructions';
export const INSTRUCTION_LIMIT = 1500;
const clean = value => String(value ?? '').replace(/[–—]/g, '-').replace(/\r/g, '').trim().slice(0, INSTRUCTION_LIMIT);

// Text added to every agent's system prompt. Company rules and safety rules above still win.
export function instructionsText(data) {
  if (!data || data.enabled === false) return '';
  const about = clean(data.about), style = clean(data.style);
  if (!about && !style) return '';
  return ['Operator custom instructions. Follow them unless they conflict with the rules above.',
    about && 'About the operator: ' + about, style && 'How to respond: ' + style].filter(Boolean).join('\n');
}

export function createInstructionsHandler({ env = process.env, openStore = () => openJarvisStore(env) } = {}) {
  return async function handler(request) {
    const { response } = guard(request, { env, methods: ['GET', 'POST'] });
    if (response) return response;
    let store;
    try { store = await openStore(); } catch { return json({ error: 'JARVIS storage is unavailable.' }, 503); }
    if (request.method === 'GET') {
      const data = (await store.getWithMetadata(INSTRUCTIONS_KEY).catch(() => null))?.data || {};
      return json({ about: clean(data.about), style: clean(data.style), enabled: data.enabled !== false, updatedAt: data.updatedAt || null, limit: INSTRUCTION_LIMIT });
    }
    let body;
    try {
      body = await readBody(request, 8192);
      for (const field of ['about', 'style']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new TypeError();
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new TypeError();
    } catch (error) {
      return json({ error: error.status === 413 ? error.message : 'Invalid instructions.' }, error.status === 413 ? 413 : 400);
    }
    const data = { about: clean(body.about), style: clean(body.style), enabled: body.enabled !== false, updatedAt: new Date().toISOString() };
    try { await store.setJSON(INSTRUCTIONS_KEY, data); } catch { return json({ error: 'Instructions were not saved.' }, 503); }
    return json({ ...data, limit: INSTRUCTION_LIMIT });
  };
}
export default createInstructionsHandler();
export const config = { path: '/api/jarvis-instructions' };
