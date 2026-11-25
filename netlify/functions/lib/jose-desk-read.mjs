import { detectIntent } from './jose-desk.mjs';

const deskWords = /\b(?:estimating desk|jobs?|bids?|proposal(?:s)?|estimates?|takeoffs?|cost sheets?|change[- ]orders?|planhub)\b/i;
const outsideDesk = /\b(?:e-?mails?|inbox|texts?|sms|calendar|slack)\b/i;
const mutation = /^(?:jose[,\s]+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:send|resend|delete|cancel|submit|move|change|mark|update|edit|set|run|generate|assign|trigger|approve|reject|create|draft|start|add|upload|book|award|redo)\b/i;
const followUp = /^(?:(?:what|how) about |and |when |was |is |did |what |show |open |view |pull |where |can you )|\b(?:that one|this one|same job|next page|more results)\b/i;
const readOpen = /^(?:jose[,\s]+)?(?:please\s+)?(?:open|view|show|pull up)\b/i;

export function addressIn(text) {
  const full = /\b\d{1,6}\s+(?:[\p{L}\p{N}.'#-]+\s+){1,9}(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|place|pl|highway|hwy|way|parkway|pkwy)\b\.?(?:\s*,\s*[\p{L} .'-]+(?:\s*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)?)?/iu.exec(text);
  return full?.[0].trim() || /^(?:(?:it(?:'s| is)|the address is)\s+)?(\d{1,6}\s+[\p{L}][\p{L}\p{N}.' -]{1,65})[?.!]?$/iu.exec(text)?.[1] || '';
}

function viewFor(text) {
  if (/\b(?:preliminary notice|prelim|sunray)\b/i.test(text)) return 'prelim';
  if (/\b(?:sent|submitted|submission)\b/i.test(text) && /\b(?:due|evaluat(?:e|ed|ion)|scheduled|created|updated)\b/i.test(text)) return 'dates';
  if (/\bevaluat(?:e|ed|ion)\b/i.test(text)) return 'evaluation';
  if (/\b(?:scheduled|schedule date)\b/i.test(text)) return 'scheduled';
  if (/\b(?:last updated|updated when|when .*updated)\b/i.test(text)) return 'updated';
  if (/\b(?:created|creation date)\b/i.test(text)) return 'created';
  if (/\b(?:all (?:the )?dates|timeline|key dates)\b/i.test(text)) return 'dates';
  if (/\b(?:due|deadline)\b/i.test(text)) return 'due';
  if (/\b(?:sent|when.*(?:send|submit)|submission date)\b/i.test(text)) return 'sent';
  if (/\b(?:pdf|download)\b/i.test(text)) return 'pdf';
  if (/\b(?:cost sheet|costsheet|spreadsheet)\b/i.test(text)) return 'cost';
  if (/\btakeoffs?\b/i.test(text)) return 'takeoff';
  if (/\b(?:change[- ]orders?|cos)\b/i.test(text)) return 'change_orders';
  if (/\b(?:links?|planhub|photos)\b/i.test(text)) return 'links';
  if (/\b(?:status|stage|where are we|how is)\b/i.test(text)) return 'status';
  if (/\bproposal\b/i.test(text)) return 'proposal';
  if (/\bestimate\b/i.test(text)) return 'estimate';
  return null;
}

export function projectIn(text) {
  const t = text.replace(/^jose[,\s]+/i, '').replace(/[?.!]+$/, '');
  const quoted = /["“]([^"”]+)["”]/.exec(t)?.[1];
  if (quoted) return quoted;
  const embedded = /^(?:(?:when|where|how) (?:was|did|is)|(?:our|the))\s+(?:(?:our|the)\s+)?(.+?)\s+(?:bid|job|project)\b/i.exec(t)?.[1];
  if (embedded && !/^(?:this|that|we|it)$/i.test(embedded)) return embedded.trim().slice(0, 250);
  const target = /\b(?:for|on|of|about|at)\s+(?:our\s+|the\s+)?(.+)$/i.exec(t)?.[1]
    || /^(?:what(?:'s| is) (?:the )?(?:status (?:of|on) )?|how(?:'s| is) |where (?:are we on|is) |(?:please )?(?:check on|look up|find|open|view|show(?: me)?|pull up) )(?:our |the )?(.+)$/i.exec(t)?.[1]
    || /^(?:our |the )?(.+?)\s+(?:job|bid|proposal|estimate)(?:\s+status)?$/i.exec(t)?.[1];
  if (!target || /^(?:(?:it|this|that)(?: one| job| bid| proposal)?|(?:the )?(?:proposal|estimate|cost sheet|job|bid|takeoffs?|status|(?:bid )?due date|deadline|evaluation date|scheduled date|last updated|dates|timeline|change orders?|pdf|links?|preliminary notice)(?: for (?:it|this|that))?)$/i.test(target)) return '';
  return target.replace(/\s+(?:bid|job|project|proposal|estimate)(?:\s+in\b.*|\s+status)?$/i, '')
    .replace(/\s+in\s+[^,]+$/i, '').trim().slice(0, 250);
}

export function deskRequest(prompt, previous, state) {
  const t = prompt.trim().replace(/[‘’]/g, "'");
  const intent = detectIntent(t);
  if (outsideDesk.test(t) || intent === 'texts' || /^(?:\/|(?:ask|delegate to)\s)/i.test(t)) return null;
  if (/^(?:confirm|confirmed|cancel|yes|no|do it|go ahead)[.!?]*$/i.test(t)) return null;
  if (['change', 'proposal'].includes(intent) && !readOpen.test(t)) return null;
  const address = addressIn(t);
  const prior = state?.view || (!outsideDesk.test(previous) && (deskWords.test(previous) || address) ? viewFor(previous) : null);
  const requestedView = viewFor(t);
  if (/^(?:please )?(?:list|show(?: me)?) (?:all |our |the )?(?:desk )?(?:jobs|bids|change[- ]orders)[.!?]*$/i.test(t)) {
    return { view: /orders/i.test(t) ? 'list_change_orders' : 'list_jobs' };
  }
  const writing = mutation.test(t);
  const addressed = Boolean(address && (prior || deskWords.test(t) || intent === 'lookup' || /^\d|^it(?:'s| is)/i.test(t)));
  const namedStatus = /^(?:where are we on|check on|what(?:'s| is) (?:the )?status (?:of|on))\s+\S/i.test(t)
    && !/\b(?:netlify|make(?:.com)?|groq|metrics|dashboard|deployments?|automation|system|pipeline health|highlevel)\b/i.test(t);
  const clarifyingName = state && !state.jobId && /^(?:the )?[\p{L}\p{N}][\p{L}\p{N} &.'_-]{1,60}$/u.test(t)
    && !/^(?:this|that)(?: one)?$/i.test(t);
  const relevant = addressed || namedStatus || clarifyingName || requestedView === 'prelim' || deskWords.test(t) || (state && (followUp.test(t) || /^(?:(?:option|number) )?[1-5][.!?]*$/i.test(t))) || (prior && requestedView);
  if (!relevant) return null;
  if (writing) return { unsupported: true };
  const next = /^\s*(?:next(?: page)?|more results)[.!?]*\s*$/i.test(t);
  if (next && state?.hasMore) return { view: state.view, ...(state.jobId ? { jobId: state.jobId } : state.query ? { query: state.query } : {}), offset: state.offset + 5 };
  const picked = /^(?:option\s+|number\s+)?([1-5])[.!?]*$/i.exec(t);
  if (picked && state?.choices?.[Number(picked[1]) - 1]) return { view: prior?.startsWith('list_') ? 'status' : prior, jobId: state.choices[Number(picked[1]) - 1] };
  const explicitId = /\b(?:job|opportunity) ID[ :]+([\w-]{1,64})\b/i.exec(t)?.[1];
  const query = address || projectIn(t) || (clarifyingName && !requestedView ? t.replace(/^the /i, '') : '');
  let view = requestedView || prior || 'status';
  // A named bid/proposal can be the subject of a status question.
  if (!requestedView && !address && !state) view = 'status';
  if (explicitId) return { view, jobId: explicitId };
  if (query) return { view, query };
  if (state?.jobId) return { view, jobId: state.jobId };
  if (state?.choices?.length) return { choicesPending: true, state };
  if (state?.query && !state.choices?.length) return { view, query: state.query };
  return { view };
}

export async function deskRead(args, { env, fetchImpl, actor, signal }) {
  const state = { view: args.view, ...(args.query ? { query: args.query } : {}), offset: args.offset || 0 };
  if (args.unsupported) return { answer: 'Use the Estimating Desk for this request. Jose can preview starting an estimate or drafting a change order.', state: null };
  if (!actor) return { answer: 'Desk access is not configured for this browser sign-in.', state: null };
  if (args.choicesPending) return { answer: 'Which Desk record do you mean? Reply with its number or give me a more specific job name.', state: args.state };
  if (!args.query && !args.jobId && !args.view.startsWith('list_')) return { answer: 'Which job? Give me the name or street address.', state };
  try {
    const base = new URL(env.ESTIMATING_URL);
    if (base.protocol !== 'https:' || base.username || base.password || !env.ESTIMATING_ACTION_KEY) throw new Error();
    const response = await fetchImpl(new URL('/.netlify/functions/jarvis-actions', base), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-action-key': env.ESTIMATING_ACTION_KEY },
      body: JSON.stringify({ action: 'read_job', actor, args }), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5500), ...(signal ? [signal] : [])]),
    });
    if (response.status === 403) return { answer: 'This sign-in does not have Estimating Desk access.', state: null };
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (result.missing) return { answer: 'I could not find a matching record in the Estimating Desk. What is the job name or street address?', state };
    const choices = result.matches || result.page;
    if (choices?.length) {
      const lines = choices.map((row, i) => (i + 1) + '. ' + [row.name, row.project, row.kind, row.company].filter(Boolean).join(' · '));
      const hasMore = result.total > state.offset + lines.length;
      return { answer: (result.page ? 'Select a Desk record by number.' : 'Which Desk record do you mean? Reply with the number.') + '\n' + lines.join('\n') + (hasMore ? '\nSay “next page” for more matches.' : ''),
        state: { ...state, choices: choices.map(row => row.id), hasMore } };
    }
    if (choices) return { answer: 'There are no more matching Desk records on this page.', state };
    if (!result.job?.id || !Array.isArray(result.facts)) throw new Error();
    const hasMore = result.total > state.offset + 5;
    const answer = [result.job.name, ...result.facts.map(row => row.label + ': ' + (row.value ?? 'No verified value') + ' (' + row.source + ')'),
      ...(hasMore ? ['Say “next page” for more change orders.'] : [])].join('\n');
    const links = (result.links || []).filter(link => {
      try { const url = new URL(link.url); return url.protocol === 'https:' && !url.username && !url.password && typeof link.label === 'string'; }
      catch { return false; }
    }).slice(0, 8);
    return { answer, links, verified: true, state: { ...state, jobId: result.job.id, hasMore } };
  } catch {
    return { answer: 'The Estimating Desk lookup is unavailable right now. I could not verify the record.', state: { ...state, ...(args.jobId ? { jobId: args.jobId } : {}) } };
  }
}
