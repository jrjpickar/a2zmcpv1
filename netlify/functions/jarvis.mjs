import { createGroqFailover } from './lib/jarvis-failover.mjs';
// POST /api/jarvis { role, prompt, threadId?, newThread?, previousTask?, preset?, plan? }
// Admin dashboard access, same origin and JSON required. Without threadId/newThread the call is stateless and touches no chat storage.
import { cloudflareModel, CLOUDFLARE_MODEL, compileAgents, failure, geminiModel, GEMINI_MODEL, groqModel, JARVIS_MODEL, agentNames, builtinRoles, rolePattern } from './lib/jarvis-agents.mjs';
import { createMemory, guidanceFor, historyFor, limits, openJarvisStore, sharedFor, validId } from './lib/jarvis-memory.mjs';
import { INSTRUCTIONS_KEY, instructionsText } from './jarvis-instructions.mjs';
import { guard, readBody } from './lib/jarvis-http.mjs';
import { classifyTopic } from './lib/classify-topic.mjs';
import { mailActions } from './lib/jarvis-mail-actions.mjs';
import { mailboxContext } from './lib/jarvis-mail.mjs';
import { summarize, validatePlan } from './lib/jarvis-sandbox.mjs';
import { json } from './lib/http.mjs';
import { compact } from './lib/groq.mjs';
import { report } from './lib/report.mjs';
import { PRESETS } from './lib/alerts.mjs';

const rememberAll = /^\s*(?:\/remember-all\b|remember for all(?: agents)?\s*:)\s*/i;
const remember = /^\s*(?:\/remember\b|remember(?:\s+this)?\s*:)\s*/i;
const execute = /^\s*\/execute\b/i;

async function systemContext(preset) {
  return compact(await report({ preset }));
}

function assistantRecord(result) {
  const meta = {};
  for (const name of ['trace', 'approved', 'buildSummary', 'agent', 'plan', 'planHash', 'warnings', 'validation', 'usage', 'mailAsOf', 'execute']) {
    if (result[name] !== undefined) meta[name] = result[name];
  }
  if (meta.plan && Buffer.byteLength(JSON.stringify(meta.plan)) > 12000) delete meta.plan;
  return { content: result.answer || result.error || '', meta };
}

export function createJarvisHandler({ env = process.env, fetchImpl = fetch, readSystems = systemContext, readMail = null, openStore = () => openJarvisStore(env), classifier } = {}) {
  let running = false;
  const primary = env.JARVIS_GROQ_MODEL?.trim() || JARVIS_MODEL;
  const backup = env.JARVIS_GROQ_BACKUP_MODEL?.trim();
  const transport = backup && backup !== primary ? createGroqFailover({ primary, backup, openStore, fetchImpl }) : fetchImpl;
  return async function handler(request) {
    const { access, response } = guard(request, { env });
    if (response) return response;
    let role, prompt, previousTask, threadId, newThread, preset, plan;
    try {
      const body = await readBody(request, 16384);
      ({ role, prompt, previousTask = '', threadId, newThread = false, preset = 'mtd', plan } = body);
      if (typeof role !== 'string' || !rolePattern.test(role) || typeof prompt !== 'string' || !prompt.trim()) throw new TypeError();
      if (prompt.length > (execute.test(prompt) ? 12000 : 1000)) throw new TypeError();
      if ((threadId !== undefined && !validId(threadId)) || typeof newThread !== 'boolean') throw new TypeError();
      if (typeof previousTask !== 'string' || previousTask.length > 1000 || !PRESETS.includes(preset)) throw new TypeError();
      if (plan !== undefined && (role !== 'qc' || !plan || typeof plan !== 'object' || Array.isArray(plan))) throw new TypeError();
    } catch (error) {
      if (error.status === 413) return json({ error: error.message }, 413);
      return json({ error: 'Invalid agent request.' }, 400);
    }
    if (role === 'email' && !access.mailbox) return json({ error: 'Mailbox access is not enabled for this sign-in.' }, 403);

    // Chat mode loads the thread, learned memory, company memory and bots. Custom bots always need storage.
    const requestedRole = role;
    const chat = Boolean(threadId || newThread);
    let store = null, memory = null, thread = null, learned = null, shared = [], bots = [];
    if (chat || role.startsWith('bot-') || role === 'main') {
      try {
        store = await openStore();
        memory = createMemory(store);
        [thread, learned, shared, bots] = await Promise.all([
          chat && threadId ? memory.getThread(role, threadId) : null,
          chat ? memory.getMemory(role) : null,
          chat ? memory.getShared() : [],
          memory.getBots(),
        ]);
      } catch {
        if (chat || role.startsWith('bot-')) return json({ error: 'JARVIS memory storage is unavailable.' }, 503);
        memory = null; // The main dispatcher still works statelessly without custom bots.
      }
      if (!chat) memory = null;
      if (threadId && !thread) return json({ error: 'Chat not found. Start a new chat.' }, 404);
      if (role.startsWith('bot-') && !bots.some(bot => bot.id === role)) return json({ error: 'Bot not found.' }, 404);
      if (!previousTask) previousTask = (thread?.messages || []).findLast(message => message.role === 'user')?.content.slice(0, 1000) || '';
    }
    const nameOf = id => agentNames[id] || bots.find(bot => bot.id === id)?.name || id;

    async function reply(result, status = 200) {
      if (!memory || status !== 200) return json(result, status);
      try {
        if (!thread) {
          const title = prompt.startsWith('/execute') ? 'Execute: ' + (result.plan?.task || 'plan') : prompt;
          thread = await memory.createThread(requestedRole, title, await classifier?.(title));
        }
        const { reply: stored, title } = await memory.appendExchange(requestedRole, thread.id, prompt.trim(), assistantRecord(result));
        if (result.trace && !result.lesson && !result.execute) {
          await memory.recordFact(requestedRole, prompt);
          await memory.recordRun(requestedRole, { approved: requestedRole === result.agent ? result.approved : undefined });
          if (result.agent && result.agent !== requestedRole && (builtinRoles.includes(result.agent) || bots.some(bot => bot.id === result.agent))) {
            await memory.recordRun(result.agent, { approved: result.approved });
          }
          if (result.approved === false && result.trace.includes('qc') && result.agent === 'build') await memory.recordQcFinding('build', result.answer);
        }
        return json({ ...result, threadId: thread.id, messageId: stored.id, title });
      } catch (error) {
        return json({ ...result, memoryError: error.agentStatus === 404 ? 'Chat not found.' : 'The reply was not saved to chat history.' });
      }
    }

    const all = rememberAll.exec(prompt);
    const lesson = !all && remember.exec(prompt);
    if ((all || lesson) && memory) {
      const text = prompt.slice((all || lesson)[0].length);
      try {
        if (all) {
          const saved = await memory.addShared(text);
          return reply({ answer: 'Saved to company memory. Every agent will use this: ' + saved.text, lesson: saved.id, shared: true });
        }
        const saved = await memory.addLesson(requestedRole, text);
        return reply({ answer: 'Saved. The ' + nameOf(requestedRole) + ' agent will follow this on every future request: ' + saved.text, lesson: saved.id });
      } catch (error) {
        const status = [400, 409].includes(error.agentStatus) ? error.agentStatus : 503;
        return json({ error: status === 400 ? 'Add the instruction after "remember:".' : status === 409 ? error.message : 'The lesson was not saved.' }, status);
      }
    }

    // /execute { plan JSON }: validated here with no model call. Running happens in /api/jarvis-execute.
    if (execute.test(prompt)) {
      let input;
      try {
        input = JSON.parse(prompt.replace(execute, '').trim().replace(/^```(?:json)?|```$/g, '').trim());
      } catch {
        return reply({ answer: 'The /execute command needs a JSON plan after it. No changes were made.', execute: true, trace: ['execute'], validation: { ok: false, errors: ['Invalid JSON.'], warnings: [] } });
      }
      const checked = validatePlan(input);
      return reply({ answer: summarize(checked), execute: true, trace: ['execute'], validation: { ok: checked.ok, errors: checked.errors, warnings: checked.warnings },
        ...(checked.ok ? { plan: checked.plan, planHash: checked.hash } : {}) });
    }

    const key = env.GROQ_API_KEY;
    const geminiKey = env.GEMINI_API_KEY?.trim();
    const cfAccount = env.CLOUDFLARE_ACCOUNT_ID?.trim(), cfToken = env.CLOUDFLARE_AI_TOKEN?.trim();
    if (!key && !(role === 'gemini' && geminiKey) && !(role === 'cloudflare' && cfAccount && cfToken)) return json({ error: 'Set GROQ_API_KEY to use JARVIS agents.' }, 503);
    if (running) return json({ error: 'JARVIS is processing another task. Retry shortly.' }, 429);
    running = true;
    try {
      const usage = { total: 0, calls: 0 };
      const model = groqModel(key, transport, { model: primary, usage });
      const budget = Math.min(20000, Math.max(1000, Number(env.JARVIS_HISTORY_CHARS) || limits.historyBudget));
      const history = memory ? historyFor(thread, budget) : [];
      let custom = '';
      try { custom = instructionsText((await (store || await openStore()).getWithMetadata(INSTRUCTIONS_KEY))?.data); } catch { /* instructions are optional */ }
      const sharedText = [custom, sharedFor(shared)].filter(Boolean).join('\n\n');
      const learnedCache = new Map([[requestedRole, learned]]);
      let systems;
      const deps = {
        bots,
        mailAction: access.mailbox ? mailActions({ env, fetchImpl }) : null,
        cloudflare: cfAccount && cfToken ? cloudflareModel(cfAccount, cfToken, fetchImpl, { model: env.CLOUDFLARE_AI_MODEL?.trim() || CLOUDFLARE_MODEL, usage }) : null,
        gemini: geminiKey ? geminiModel(geminiKey, fetchImpl, { model: env.GEMINI_MODEL?.trim() || GEMINI_MODEL, usage }) : null,
        systems: () => (systems ??= readSystems(preset).catch(() => { throw failure('A2Z metrics are unavailable right now.', 502); })),
        mail: async () => {
          if (!access.mailbox) throw failure('Mailbox access is not enabled for this sign-in.', 403);
          return readMail ? readMail() : mailboxContext({ env, fetchImpl, store });
        },
        guidance: async id => {
          if (!memory) return custom ? { shared: custom, history } : null;
          if (id === 'shared') return { shared: sharedText, history };
          if (!learnedCache.has(id)) learnedCache.set(id, await memory.getMemory(id));
          return { shared: sharedText, memory: guidanceFor(id, learnedCache.get(id), prompt), history };
        },
      };
      const graph = compileAgents(model, deps);
      const { result } = await graph.invoke({ role, prompt: prompt.trim(), previousTask, plan }, { recursionLimit: 8 });
      if (usage.total) result.usage = { totalTokens: usage.total, calls: usage.calls };
      return reply(result);
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'JARVIS could not complete the task. Check your provider settings and retry.' }, error.agentStatus || 502);
    } finally {
      running = false;
    }
  };
}

export default createJarvisHandler({ classifier: classifyTopic });
export const config = { path: '/api/jarvis' };
