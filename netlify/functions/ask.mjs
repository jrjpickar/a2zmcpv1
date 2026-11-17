import { authorized, json } from './lib/http.mjs';
import { report } from './lib/report.mjs';
import { ask } from './lib/groq.mjs';
import { evaluate, loadSettings } from './lib/alerts.mjs';

// POST /api/ask { question?, preset? }. No question returns the HQ overview. Needs the dashboard key: every call can spend Groq tokens.
export default async (request, { fetchImpl = fetch, store } = {}) => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  if (!authorized(request, process.env.DASHBOARD_KEY, 'x-a2z-key')) return json({ error: 'Dashboard key required' }, 401);
  try {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'Payload too large' }, 413);
    const body = JSON.parse(text || '{}');
    const result = await report({ preset: body.preset || 'mtd' });
    const alerts = await loadSettings(store).then(s => evaluate(s)).then(r => r.alerts).catch(() => []);
    const ai = await ask({ question: body.question, result, alerts, fetchImpl });
    if (!ai.configured) return json({ configured: false, answer: null, signals: result.signals, note: 'GROQ_API_KEY is not set. Showing rule-based signals.' });
    return json({ ...ai, signals: result.signals });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return json({ error: error.message }, 400);
    return json({ error: error.status ? error.message : 'Ask unavailable' }, error.status || 500);
  }
};
export const config = { path: '/api/ask' };
