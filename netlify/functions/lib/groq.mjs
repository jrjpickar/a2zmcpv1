// One Groq chat completion over aggregate metrics. No crew names, phones or contact data are sent.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export function compact(r, alerts = []) {
  const { crew, bench, ...workforce } = r.kpis.workforce || {};
  return {
    range: r.range, mode: r.mode,
    funnel: r.kpis.funnel, labor: r.kpis.labor && { count: r.kpis.labor.count, amount: r.kpis.labor.amount }, containers: r.kpis.containers,
    pipelines: (r.kpis.pipelines || []).map(p => [p.name, p.count, p.amount, p.jobs?.[0]?.value ?? null]), pipelineColumns: ['name', 'wins', 'wonValue', 'largestWin'],
    workforce: r.kpis.workforce ? workforce : null,
    runway: { months: r.kpis.runway.months, cash: r.kpis.runway.cash, monthlyBurn: r.kpis.runway.monthlyBurn, basis: r.kpis.runway.basis },
    system: {
      feeds: Object.fromEntries(Object.entries(r.system.sources).map(([k, v]) => [k, v.status])),
      deploys: Object.fromEntries(Object.entries(r.system.deploys).map(([k, v]) => [k, v.state || v.status])),
      twilioBalance: r.system.twilio?.balance ?? null, makeCredits: r.system.make?.balance ?? null, netlifyCredits: r.system.netlify?.balance ?? null,
      pendingSyncs: r.system.dispatch?.pendingSyncs ?? null, makeRunsToReview: r.system.dispatch?.makeRuns30d?.bad ?? null,
    },
    signals: r.signals.map(s => s.tone + ': ' + s.text),
    alertsTriggered: alerts.map(a => a.message),
  };
}

const SYSTEM = [
  'You are the operations analyst for A2Z Construction Services, a demolition and labor subcontractor in Southern California.',
  'Answer only from the JSON metrics given. If the data cannot answer, say what is missing.',
  'Lead with the answer. Use numbers. Keep it under 90 words unless asked for more. Short bullets or plain sentences.',
  'Never use em dashes or en dashes. Do not invent figures, people or jobs.',
].join(' ');
const OVERVIEW = 'Give a signal-first overview in 3 short bullets: the most urgent issue, the strongest positive, and one action for today.';

const answers = new Map();
export async function ask({ question, result, alerts = [], env = process.env, fetchImpl = fetch }) {
  const key = env.GROQ_API_KEY;
  if (!key) return { configured: false, answer: null };
  const q = String(question || '').trim().slice(0, 600) || OVERVIEW;
  const model = env.GROQ_MODEL || DEFAULT_MODEL;
  const context = JSON.stringify(compact(result, alerts));
  const cacheKey = q.toLowerCase() + '|' + context;
  const hit = answers.get(cacheKey);
  if (hit && Date.now() - hit.at < 600000) return { ...hit.value, cached: true };
  const response = await fetchImpl(GROQ_URL, {
    method: 'POST', signal: AbortSignal.timeout(25000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.2, reasoning_effort: 'low', include_reasoning: false,
      max_completion_tokens: Number(env.GROQ_MAX_TOKENS) || 900,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Metrics JSON:\n' + context + '\n\nQuestion: ' + q }],
    }),
  });
  if (!response.ok) throw Object.assign(new Error('Groq request failed (HTTP ' + response.status + ')'), { status: 502 });
  const data = await response.json();
  const answer = String(data.choices?.[0]?.message?.content || '').replace(/[–—]/g, '-').trim();
  if (!answer) throw Object.assign(new Error('Groq returned no answer'), { status: 502 });
  const value = { configured: true, model: data.model || model, answer };
  answers.set(cacheKey, { at: Date.now(), value });
  if (answers.size > 50) answers.delete(answers.keys().next().value);
  return value;
}
