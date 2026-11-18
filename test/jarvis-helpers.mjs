// Shared fixtures for the JARVIS tests. No live Groq, email or Netlify calls.
export const env = { DASHBOARD_KEY: 'a2z-dashboard-test-key', GROQ_API_KEY: 'gsk_test_fixture' };
export const origin = 'https://ops.a2z.test';
export function post(path, body, headers = {}) {
  return new Request(origin + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-a2z-key': env.DASHBOARD_KEY, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
export function get(path, headers = {}) {
  return new Request(origin + path, { headers: { 'x-a2z-key': env.DASHBOARD_KEY, ...headers } });
}
export function groqReply(content, tokens = 100) {
  return Response.json({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { total_tokens: tokens } });
}
// Groq fixture that answers from a queue of responders and records every request body.
export function fakeGroq(...responders) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url) !== 'https://api.groq.com/openai/v1/chat/completions') throw new Error('Unexpected fetch ' + url);
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = responders.length > 1 ? responders.shift() : responders[0];
    return groqReply(typeof next === 'function' ? next(body, calls.length) : next);
  };
  return { calls, fetchImpl };
}
export const plan = {
  task: 'Wins by pipeline',
  description: 'Bind the pipelines module to a view of won value by pipeline.',
  steps: [
    { action: 'Create View', sql: 'CREATE OR REPLACE VIEW wins_by_pipeline AS SELECT pipeline, SUM(value) AS won FROM won_jobs GROUP BY pipeline;' },
    { action: 'Update Module', module: 'Pipelines', field: 'wonValue', source: 'wins_by_pipeline', fieldName: 'won' },
    { action: 'Schedule Refresh', schedule: '0 2 * * *', description: 'Nightly refresh' },
    { action: 'Trigger Immediate Update', module: 'pipelines' },
  ],
  validation: [{ check: 'View has rows', query: 'SELECT pipeline, won FROM wins_by_pipeline LIMIT 10;' }],
};
