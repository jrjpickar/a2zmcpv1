// Preload for local UI checks with no live Groq calls: node --import ./sandbox/fake-groq.mjs sandbox/server.mjs
// Answers Groq requests with fixtures chosen from the system prompt. All other requests pass through.
process.env.GROQ_API_KEY ||= 'gsk_fake_fixture';
const real = globalThis.fetch;
let count = 0;
const reply = (content, tokens) => Response.json({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { total_tokens: tokens } });
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.groq.com/')) return real(url, init);
  const body = JSON.parse(init.body);
  const system = body.messages[0].content;
  const user = body.messages.at(-1).content;
  count++;
  if (/Jose dispatcher/.test(system)) return reply({ agent: 'systems' }, 120);
  if (/maintain the operating playbook/.test(system)) return reply({ playbook: ['Lead with the number that changed most', 'Keep answers under 80 words'] }, 300);
  if (/Development agent/.test(system)) return reply({ summary: 'Plan: a view of won value by pipeline, bound to the pipelines module, refreshed nightly.', plan: {
    task: 'Won value by pipeline', description: 'Bind pipelines to a won value view.',
    steps: [{ action: 'Create View', sql: 'CREATE VIEW won_by_pipeline AS SELECT pipeline, SUM(value) AS won FROM won_jobs GROUP BY pipeline' },
      { action: 'Update Module', module: 'pipelines', field: 'wonValue', source: 'won_by_pipeline', fieldName: 'won' },
      { action: 'Schedule Refresh', schedule: '0 2 * * *' }, { action: 'Trigger Immediate Update', module: 'pipelines' }],
    validation: [{ check: 'Rows exist', query: 'SELECT * FROM won_by_pipeline' }] } }, 650);
  if (/independent A2Z QC/.test(system)) return reply({ approved: true, findings: 'The view answers the request and the check proves it has rows.' }, 280);
  const history = body.messages.length - 2;
  return reply('Fixture reply ' + count + '. History turns: ' + history + '. Request: ' + JSON.parse(user).request.slice(0, 80), 210);
};
