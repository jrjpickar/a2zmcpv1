// Jose: change orders, proposals and GHL texts, for voice and the Jose chat.
//
// Intents are matched with fixed patterns. A model is used only to pull the job, the change and the
// contact out of the sentence (extract), and its output is checked here. Writes always go through
// the Desk preview first. The operator hears or reads the preview, then says "confirm" (or "cancel")
// within 5 minutes. The confirm reuses the stored hash and idempotency key, so a retried confirm
// cannot create a second change order.
//
// Text messages are untrusted data: they are read back, never followed.
import { randomUUID } from 'node:crypto';
import { deskAction } from './estimating-actions.mjs';
import { findJobs, readTexts } from './edge.mjs';

export const PENDING_MS = 5 * 60000;
const confirmWords = /^\s*(?:yes|yeah|yep|confirm(?:ed)?|do it|go ahead|create it|start it|approved?)\b/i;
const cancelWords = /^\s*(?:no|nope|cancel|stop|never ?mind|don'?t)\b/i;
// Questions about change orders or proposals go to the normal agents, not to a write.
const question = /^\s*(?:jose[,\s]+)?(?:how|what|which|when|why|who|did|does|is|are|were|was|show|list|count)\b/i;
const intents = {
  texts: text => /\b(?:texts?|sms|text messages?)\b/i.test(text) && !/\be-?mails?\b/i.test(text),
  change: text => !question.test(text) && /\b(?:change[- ]?orders?|c\.?\s?o\.?)\b/i.test(text) &&
    (/\b(?:draft|create|make|start|write|open|new|add|put in|do)\b/i.test(text) || /\b(?:change[- ]?order|c\.?\s?o\.?)\s+(?:on|for|at)\b/i.test(text)),
  lookup: text => /\b(?:look ?up|pull up|find|check on|where(?:'s| is| are we on)|what(?:'s| is) the (?:stage|status))\b/i.test(text) &&
    /\b\d{2,6}\s+[a-z]/i.test(text) && !/\b(?:e-?mails?|inbox|texts?|sms)\b/i.test(text),
  proposal: text => !question.test(text) && /\b(?:proposal|estimate|bid)\b/i.test(text) && /\b(?:start|begin|kick off|work on|open|get going on|run)\b/i.test(text),
};
const clean = (value, max) => (typeof value === 'string' ? value.replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const when = at => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const day = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }) : iso);

export function detectIntent(text) {
  // "start the estimate on change order 1" starts an estimate, it does not draft a new change order.
  if (intents.proposal(text)) return 'proposal';
  if (intents.change(text)) return 'change';
  if (intents.texts(text)) return 'texts';
  if (intents.lookup(text)) return 'lookup';
  return null;
}

export const EXTRACT_INSTRUCTION = 'Extract fields from one operator request to an A2Z demolition job assistant. Return JSON only: ' +
  '{"job": "the job address or job name as spoken, or empty", "change": "what changed in the field for a change order, in plain words, or empty", ' +
  '"contact": "the person name or phone number whose texts are wanted, or empty"}. Copy words from the request. Do not invent anything.';

// Fallback when no model is available: "... on|for|at <job> for|to|: <change>".
export function regexExtract(text) {
  const t = text.trim().replace(/[?.!]+$/, '');
  const both = /\b(?:on|at)\s+(?:the\s+)?(.+?)(?:\s+(?:job|project))?\s+(?:for|because|to)\s+(.+)$/i.exec(t);
  const job = both?.[1] || /\b(?:on|for|at)\s+(?:the\s+)?(.+?)(?:\s+(?:job|project))?$/i.exec(t)?.[1] || '';
  const contact = /\b(?:from|with)\s+(.+)$/i.exec(t)?.[1] || '';
  return { job, change: both?.[2] || '', contact };
}

async function fields(text, extract) {
  let out = null;
  if (extract) { try { out = await extract(text); } catch { out = null; } }
  if (!out || typeof out !== 'object') out = regexExtract(text);
  return { job: clean(out.job, 120), change: clean(out.change, 2000), contact: clean(out.contact, 120) };
}

function pick(jobs) {
  if (!jobs.length) return { none: true };
  if (jobs.length === 1 || jobs[0].score > jobs[1].score) return { job: jobs[0] };
  return { choices: jobs.slice(0, 3).map(job => job.name) };
}

const PIPELINES = { demo: 'Demo', labor: 'Labor', containers: 'Containers', change_orders: 'Change Orders' };
const pipelineOf = job => job.pipelineName || PIPELINES[job.pipeline] || 'unknown pipeline';
const describe = job => job.name + ', ' + pipelineOf(job) + (job.stage ? ', ' + job.stage : '') + (job.status === 'won' ? ' (won)' : job.status === 'lost' ? ' (lost)' : '');

function readback(preview, args) {
  if (preview.action === 'draft_change_order') {
    return 'Ready: ' + preview.coName + '. Change: ' + args.description + '. Due ' + day(preview.dueDate) + '. Nothing goes to the GC. Say confirm to create it, or cancel.';
  }
  const move = preview.isChangeOrder ? ' and moves it to CO in Progress' : ' and moves it to the job cost stage';
  return 'Ready to start the estimate for ' + preview.jobName + ' (' + (preview.stage || 'unknown stage') + '). This sends the job cost webhook' +
    (preview.movesStage ? move : ' and keeps its stage') + '. Say confirm to start it, or cancel.';
}

async function previewAction(action, args, ctx) {
  const { status, data } = await deskAction({ action, dryRun: true, args, actor: ctx.actor }, ctx);
  if (status === 422) return { answer: 'The Desk needs more detail: ' + (data.missing_fields || []).join(', ') + '.', pending: null };
  if (status !== 200 || !data.preview) return { answer: data.error || 'The Desk could not build a preview. Nothing was created.', pending: null };
  const preview = data.preview;
  if (!preview.canConfirm) return { answer: (preview.error || 'The Desk will not allow this.') + ' Nothing was created.', pending: null };
  return {
    answer: readback(preview, args),
    pending: { action, args, hash: preview.hash, idempotencyKey: randomUUID(), expires: ctx.now() + PENDING_MS },
  };
}

async function confirm(pending, ctx) {
  const { status, data } = await deskAction({ action: pending.action, dryRun: false, args: pending.args, hash: pending.hash, idempotencyKey: pending.idempotencyKey, actor: ctx.actor }, ctx);
  if (status === 200) {
    if (pending.action === 'draft_change_order') {
      return { answer: 'Created ' + data.changeOrderName + ' at Customer Requested, due ' + day(data.dueDate) + (data.dueDateSaved === false ? ' (the due date did not save, set it in the Desk)' : '') + '. Open the Desk to price it and generate the CO.', pending: null };
    }
    const moved = data.isChangeOrder ? ' and the change order moved to CO in Progress.' : ' and the job moved to the job cost stage.';
    return { answer: 'Estimate started for ' + data.jobName + '. The job cost webhook was sent' + (data.stageMoved ? moved : '.') + ' The cost sheet shows in the Desk when Make finishes.', pending: null };
  }
  if (status === 409 && data.preview?.canConfirm) {
    return { answer: 'The job changed since the preview. ' + readback(data.preview, pending.args), pending: { ...pending, hash: data.preview.hash, idempotencyKey: randomUUID(), expires: ctx.now() + PENDING_MS } };
  }
  if (ctx.scoped && status >= 500) {
    return { answer: 'The Desk could not verify the outcome. Check the record before retrying.', pending: null };
  }
  return { answer: (data.error || 'The Desk did not complete it.') + ' Nothing was created.', pending: null };
}

async function texts(text, ctx) {
  if (!ctx.access?.mailbox) return 'Text access is not enabled for this sign-in.';
  const { contact } = await fields(text, ctx.extract);
  const max = ctx.voice ? 3 : 5;
  if (!contact || /\b(?:new|unread|any)\b/i.test(text) && !/\b(?:from|with)\b/i.test(text)) {
    const { conversations = [] } = await readTexts({ unread: true, limit: max }, ctx);
    if (!conversations.length) return 'No unread texts.';
    return conversations.length + ' unread text conversation' + (conversations.length === 1 ? '' : 's') + '. ' +
      conversations.map(c => c.contactName + ', ' + when(c.at) + ': ' + clean(c.lastBody, ctx.voice ? 140 : 300)).join('. ') + '.';
  }
  const data = await readTexts({ query: contact, limit: max }, ctx);
  if (data.matches && !data.messages) {
    return data.matches.length ? 'I found more than one: ' + data.matches.map(m => m.contactName).join(', ') + '. Who do you mean?' : 'No text conversation found for ' + contact + '.';
  }
  if (!data.messages?.length) return 'No texts with ' + data.contact.contactName + '.';
  return 'Last ' + data.messages.length + ' text' + (data.messages.length === 1 ? '' : 's') + ' with ' + data.contact.contactName + ', newest first. ' +
    data.messages.map(m => (m.direction === 'outbound' ? 'A2Z' : data.contact.contactName) + ', ' + when(m.at) + ': ' + clean(m.body, ctx.voice ? 200 : 500)).join('. ') + '.';
}

// ctx: { env, fetchImpl, signal, actor, access: { admin, mailbox }, extract(text) -> object, voice, now }
// Returns null when the request is not for this handler, else { answer, pending }.
// pending: the stored preview (or null to clear it). The caller saves it per session or per user.
export async function joseDesk(text, pending, input) {
  const ctx = { now: Date.now, ...input };
  const live = pending && pending.expires > ctx.now() ? pending : null;
  const confirmed = ctx.scoped ? /^(?:confirm|yes[, ]+confirm)[.!]?$/i.test(text.trim()) : confirmWords.test(text);
  if (live && confirmed) {
    if (!ctx.access?.admin) return { answer: 'Administrator access is required.', pending: null };
    return confirm(live, ctx);
  }
  if (live && cancelWords.test(text)) return { answer: 'Canceled. Nothing was created.', pending: null };
  const intent = detectIntent(text);
  if (!intent) {
    if (pending && !live && confirmed) return { answer: 'That preview expired. Ask again and I will rebuild it.', pending: null };
    return null;
  }
  try {
    if (intent === 'texts') return { answer: await texts(text, ctx), pending: live };
    if (intent === 'lookup') {
      const query = (await fields(text, ctx.extract)).job || /\b\d{2,6}\s+[^?.!,]+/.exec(text)?.[0] || '';
      if (!query) return { answer: 'Which job? Say the address.', pending: live };
      const { jobs = [] } = await findJobs(query, { limit: ctx.voice ? 3 : 5 }, ctx);
      if (!jobs.length) return { answer: 'Nothing in Demo, Labor, Containers or Change Orders matches ' + query + '.', pending: live };
      return { answer: (jobs.length === 1 ? 'Found ' : 'Found ' + jobs.length + ': ') + jobs.map(describe).join('. ') + '.', pending: live };
    }
    if (!ctx.access?.admin) return { answer: 'Administrator access is required for change orders and estimates.', pending: live };
    const { job, change } = await fields(text, ctx.extract);
    if (ctx.resolveJob) {
      if (intent === 'change' && !change) return { answer: 'What changed on the job? Include the change when asking to draft the change order.', pending: live };
      const resolved = await ctx.resolveJob(text, job);
      const jobId = resolved.verified ? resolved.state?.jobId : null;
      if (!jobId) return { answer: resolved.answer, pending: live, state: resolved.state };
      const next = intent === 'change'
        ? await previewAction('draft_change_order', { jobId, description: change, requestedBy: clean(ctx.actorName || ctx.actor, 120) }, ctx)
        : await previewAction('start_proposal', { jobId }, ctx);
      return { ...next, state: resolved.state };
    }
    if (!job) return { answer: intent === 'change' ? 'Which job, and what changed? For example: draft a change order on 123 Main for 400 square feet of extra drywall demo.' : 'Which job should I start the estimate on?', pending: live };
    if (intent === 'change' && !change) return { answer: 'What changed on ' + job + '? Say it in one sentence with the job, like: change order on ' + job + ' for the extra back wall.', pending: live };
    // Change orders hang off won Demo jobs (Labor and Containers are searched so Jose can say why not).
    // Estimates start on Demo jobs and on change orders.
    const pipelines = intent === 'change' ? ['demo', 'labor', 'containers'] : ['demo', 'change_orders'];
    const { jobs = [] } = await findJobs(job, { won: intent === 'change', limit: 3, pipelines }, ctx);
    const choice = pick(jobs);
    if (choice.none) return { answer: 'I could not find ' + (intent === 'change' ? 'a won job' : 'a Demo job or change order') + ' matching ' + job + '.', pending: live };
    if (choice.choices) return { answer: 'I found ' + choice.choices.join(', ') + '. Say the full address.', pending: live };
    if (intent === 'change' && choice.job.pipeline !== 'demo') {
      return { answer: choice.job.name + ' is in ' + pipelineOf(choice.job) + '. The Desk only drafts change orders on won Demo jobs. Nothing was created.', pending: live };
    }
    return intent === 'change'
      ? previewAction('draft_change_order', { jobId: choice.job.id, description: change, requestedBy: clean(ctx.actorName || ctx.actor, 120) }, ctx)
      : previewAction('start_proposal', { jobId: choice.job.id }, ctx);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return { answer: (error.status && error.message ? error.message : 'That lookup failed.') + ' Nothing was created.', pending: live };
  }
}
