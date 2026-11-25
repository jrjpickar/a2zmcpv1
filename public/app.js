import { mountVoice } from './voice.js';
import { setupMap, stations } from './map.js';
import { instructionsForm } from './instructions.mjs';

const $ = id => document.getElementById(id);
const number = value => value == null ? '-' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const money = (value, currency = 'USD') => value == null ? '-'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
const whole = value => value == null ? '-' : Math.abs(value) >= 1000
  ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value) : money(value);
const plural = (count, word) => number(count) + ' ' + word + (count === 1 ? '' : 's');
const colors = Object.fromEntries(stations.map(s => [s.key, s.color]));
const palette = ['#e6b072', '#7bad9a', '#9bb4c5', '#c9a2d6', '#dc8c60', '#cfc27a', '#8da18a', '#d98aa0'];
const highlevelMode = new URLSearchParams(location.search).get('highlevel') === '1';
const highlevelOrigins = ['https://app.gohighlevel.com', 'https://app.leadconnectorhq.com'];
let highlevelSession;
let signingIn;
let key = highlevelMode ? '' : sessionStorage.getItem('a2z-key') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (!highlevelMode && fragment.has('key')) {
  key = fragment.get('key');
  sessionStorage.setItem('a2z-key', key);
  history.replaceState(null, '', location.pathname + location.search);
}
function authHeaders(extra = {}) {
  const credentials = highlevelMode ? { 'x-a2z-session': highlevelSession?.token || '' } : { 'x-a2z-key': key };
  return { ...credentials, ...extra };
}

function highlevelContext() {
  if (window.parent === window) throw new Error('Open A2Z Operations from its HighLevel Custom Page.');
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      callback(value);
    };
    const onMessage = event => {
      if (event.source !== window.parent || !highlevelOrigins.includes(event.origin) ||
          event.data?.message !== 'REQUEST_USER_DATA_RESPONSE' || typeof event.data.payload !== 'string') return;
      finish(resolve, event.data.payload);
    };
    const timer = setTimeout(() => finish(reject, new Error('HighLevel did not return a sign-in session.')), 6500);
    addEventListener('message', onMessage);
    for (const origin of highlevelOrigins) window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, origin);
  });
}

async function signInHighLevel() {
  if (highlevelSession?.expires * 1000 > Date.now() + 60000) return;
  if (signingIn) return signingIn;
  signingIn = (async () => {
    const encryptedData = await highlevelContext();
    const response = await fetch('/api/highlevel/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedData }), signal: AbortSignal.timeout(9000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'HighLevel sign-in failed.');
    highlevelSession = result;
  })();
  try {
    await signingIn;
  } finally {
    signingIn = null;
  }
}

const voiceDialog = $('voice-dialog');
mountVoice($('voice-panel'), {
  async getHeaders() {
    if (highlevelMode) await signInHighLevel();
    return authHeaders();
  },
  getPreset: () => $('range').value,
});
$('call-brain').onclick = () => voiceDialog.showModal();
$('voice-close').onclick = () => voiceDialog.close();
voiceDialog.addEventListener('close', () => $('voice-panel').dispatchEvent(new Event('close')));

let report;
let selected = null;
let alertView = null;
let worker = null;
let pending;
let mail = { status: 'loading' };
let previousUnread = null;
let previousArrival = null;
let commandCenter = {};
let digest = { sections: [], count: 0, cursor: null };
let mailRequest;
const map = window.A2ZCity?.supported() ? city3d() : setupMap($('city'), $('stations'), id => select(id, true));

function city3d() {
  $('city').hidden = true;
  $('stations').hidden = true;
  $('map').classList.add('live');
  const view = window.A2ZCity.mount($('map'), { onSelect: (id, index) => select(id, false, index ?? null) });
  return { update: (values, id) => { view.update(report, values, palette, alertDistricts(), cityAgents()); view.select(id, worker, false); }, reset: view.reset, select: view.select, deliverMail: view.deliverMail,
    agentState: view.agentState, agentSay: view.agentSay, agentFlow: view.agentFlow };
}

function tiles() {
  const { kpis, system } = report;
  const deploys = Object.values(system.deploys);
  const ready = deploys.filter(d => d.state === 'ready').length;
  const checked = deploys.filter(d => d.status === 'ok').length;
  const sources = Object.values(system.sources);
  const pipelines = kpis.pipelines;
  const won = pipelines?.reduce((t, p) => t + p.count, 0);
  const proposals = kpis.funnel?.proposals;
  return [
    { key: 'leads', title: 'New leads', short: 'Leads', value: number(kpis.funnel?.leads), sub: 'Primary pipeline' },
    { key: 'proposals', title: 'Proposals sent', short: 'Proposals', value: number(proposals), sub: 'Bids out the door' },
    { key: 'wins', title: 'Jobs won', short: 'Jobs won', value: number(kpis.funnel?.wins),
      sub: proposals ? Math.round(kpis.funnel.wins / proposals * 100) + '% of proposals' : 'Awarded jobs' },
    { key: 'labor', title: 'Labor sales', short: 'Labor', value: whole(kpis.labor?.amount), sub: kpis.labor ? plural(kpis.labor.count, 'job') + ' won' : 'GoHighLevel' },
    { key: 'pipelines', title: 'Pipeline sales', short: 'Pipelines', value: whole(pipelines?.reduce((t, p) => t + p.amount, 0)),
      sub: pipelines ? plural(won, 'win') + ' · ' + plural(pipelines.filter(p => p.count).length, 'pipeline') : 'GoHighLevel' },
    { key: 'workforce', title: 'Workforce', short: 'Workforce', value: kpis.workforce ? number(kpis.workforce.workers) + ' booked' + (kpis.workforce.available == null ? '' : ' · ' + number(kpis.workforce.available) + ' available') : '-',
      sub: kpis.workforce ? plural(kpis.workforce.jobs, 'job') + ' today' : 'Dispatch' },
    { key: 'runway', title: 'Financial runway', short: 'Runway', value: kpis.runway.months == null ? '-' : number(kpis.runway.months) + ' mo',
      sub: kpis.runway.cash == null ? 'Cash feed needed' : whole(kpis.runway.cash) + ' cash' },
    ...(report.access?.mailbox === false ? [] : [
      { key: 'mail', title: 'Mail', short: 'Mail', value: mail.stats ? plural(mail.stats.unreadIncoming, 'unread message') : '', sub: 'A2Z Email Inbox' },
    ]),
    { key: 'hq', title: 'A2Z HQ', short: 'HQ', value: '', sub: '' },
    { key: 'system', title: 'System health', short: 'Systems', value: checked ? ready + ' / ' + deploys.length + ' live' : '-',
      sub: sources.filter(x => x.status === 'ok').length + ' / ' + sources.length + ' feeds connected' },
  ];
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function rows(values) {
  const list = node('dl', undefined, 'rows');
  for (const [label, value, detail] of values) {
    if (value === undefined) { list.append(node('dt', label, 'group')); continue; }
    const row = node('div', undefined, 'row');
    const cell = node('dd');
    cell.append(value instanceof Node ? value : String(value));
    row.append(node('dt', label), cell);
    if (detail) row.append(node('small', detail));
    list.append(row);
  }
  return list;
}

function badge(status, text) {
  const tone = { ok: 'ok', ready: 'ok', setup: 'warn', building: 'warn', enqueued: 'warn', error: 'bad' }[status] || 'bad';
  return node('span', text, 'badge ' + tone);
}

function pipelineList(target, items) {
  target.replaceChildren();
  if (!items) {
    target.append(node('p', report.system.sources.ghl?.status === 'setup' ? 'Connect GoHighLevel to see sales by pipeline.' : 'GoHighLevel sales unavailable.', 'muted empty'));
    return;
  }
  const max = Math.max(...items.map(p => p.amount), 1);
  const total = items.reduce((t, p) => t + p.amount, 0);
  const list = node('ol', undefined, 'bars');
  items.forEach((p, i) => {
    const item = node('li', undefined, 'bar' + (p.count ? '' : ' idle'));
    item.style.setProperty('--c', palette[i % palette.length]);
    item.style.setProperty('--w', (p.amount / max * 100).toFixed(1) + '%');
    const head = node('div', undefined, 'bar-head');
    head.append(node('span', p.name, 'bar-name'), node('strong', whole(p.amount)));
    const notes = [plural(p.count, 'win'), total ? Math.round(p.amount / total * 100) + '% of total' : null,
      p.missingValue && plural(p.missingValue, 'win') + ' missing value', p.missingDate && plural(p.missingDate, 'win') + ' missing date'];
    item.append(head, node('div', undefined, 'track'), node('small', notes.filter(Boolean).join(' · ')));
    list.append(item);
  });
  target.append(list);
}

// HQ: rule-based signals right away, then the Groq overview, plus a prompt.
let brief = null;
function hqPanel(panel) {
  $('detail-title').textContent = 'A2Z HQ';
  const list = node('ul', undefined, 'signals');
  for (const sig of report.signals || []) {
    const li = node('li', undefined, 'signal ' + sig.tone);
    li.append(node('span', { act: 'Act', watch: 'Watch', good: 'Good' }[sig.tone], 'tone'), node('span', sig.text));
    li.addEventListener('click', () => { if (sig.area !== 'hq') select(sig.area); });
    list.append(li);
  }
  const ai = node('div', undefined, 'ai');
  ai.append(node('h3', 'Groq overview'));
  const out = node('div', undefined, 'ai-answer');
  ai.append(out);
  const form = node('form', undefined, 'ask');
  const input = node('input'); input.type = 'text'; input.placeholder = 'Ask about these numbers'; input.maxLength = 600; input.setAttribute('aria-label', 'Ask Groq');
  const go = node('button', 'Ask', 'primary'); go.type = 'submit';
  form.append(input, go);
  form.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) runAsk(out, input.value.trim(), go); });
  ai.append(form);
  panel.append(list, ai);
  const stamp = report.generatedAt + $('range').value;
  if (brief?.stamp === stamp) showAnswer(out, brief.data);
  else runAsk(out, '', null, stamp);
}
function showAnswer(out, data) {
  out.replaceChildren();
  if (data.error) { out.append(node('p', data.error, 'muted')); return; }
  if (!data.answer) { out.append(node('p', data.note || 'No answer.', 'muted')); return; }
  for (const line of data.answer.split('\n').map(l => l.trim()).filter(Boolean)) {
    const bullet = /^[-*•]\s*/.test(line);
    out.append(node(bullet ? 'p' : 'p', line.replace(/^[-*•]\s*/, '').replace(/\*\*/g, ''), bullet ? 'bullet' : ''));
  }
  if (data.model) out.append(node('small', data.model + (data.cached ? ' · cached' : ''), 'muted'));
}
async function runAsk(out, question, button, stamp) {
  out.replaceChildren(node('p', question ? 'Thinking…' : 'Writing the overview…', 'muted thinking'));
  if (button) button.disabled = true;
  let data;
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question, preset: $('range').value }) });
    data = await response.json().catch(() => ({ error: 'Ask unavailable' }));
    if (!response.ok) data = { error: data.error || 'Ask unavailable' };
  } catch { data = { error: 'Ask unavailable' }; }
  if (button) button.disabled = false;
  if (!question && stamp) brief = { stamp, data };
  if (out.isConnected) showAnswer(out, data);
}

// Jobs won: one dropdown per pipeline, won opportunities sorted by value.
function wonByPipeline(panel, items, title = 'Won by pipeline') {
  panel.append(node('h3', title, 'crew-title'));
  if (!items) { panel.append(node('p', 'GoHighLevel sales unavailable.', 'muted')); return; }
  const list = items.filter(p => p.count);
  if (!list.length) { panel.append(node('p', 'No won opportunities in this period.', 'muted')); return; }
  list.forEach((p, i) => {
    const box = node('details', undefined, 'won');
    box.open = i === 0;
    box.style.setProperty('--c', palette[items.indexOf(p) % palette.length]);
    const summary = node('summary');
    summary.append(node('span', p.name, 'bar-name'), node('small', plural(p.count, 'win')), node('strong', whole(p.amount)));
    box.append(summary);
    const ol = node('ol', undefined, 'won-list');
    for (const job of p.jobs || []) {
      const li = node('li');
      li.append(node('span', job.name), node('strong', job.value == null ? 'No value' : whole(job.value), job.value == null ? 'muted' : ''), node('small', job.at || ''));
      ol.append(li);
    }
    box.append(ol);
    if (p.jobsMore) box.append(node('p', '+ ' + plural(p.jobsMore, 'more win') + ' not listed', 'muted'));
    panel.append(box);
  });
}

function roster() {
  const wf = report.kpis.workforce;
  return [...(wf?.crew || []).map(c => ({ ...c, status: 'booked' })), ...(wf?.bench || []).map(c => ({ ...c, status: 'available' }))];
}

function details(tile) {
  $('detail').hidden = !tile;
  if (!tile) return;
  $('detail-title').textContent = tile.title;
  const panel = $('detail-content');
  panel.replaceChildren();
  const { kpis, system } = report;
  const firing = triggered().filter(a => a.district === tile.key);
  if (firing.length) {
    const box = node('div', undefined, 'firing');
    box.append(node('strong', firing.length === 1 ? '1 alert triggered' : firing.length + ' alerts triggered'));
    for (const a of firing) box.append(node('span', a.message));
    panel.append(box);
  }
  const ask = askAbout(tile);
  if (ask) panel.append(ask);
  if (tile.key === 'hq') return hqPanel(panel);
  if (tile.key === 'mail') return mailPanel(panel);
  if (tile.key === 'system') {
    const deployRows = Object.entries(system.deploys).map(([name, deploy]) => [
      name, badge(deploy.state || deploy.status, deploy.state || (deploy.status === 'setup' ? 'Setup needed' : 'Unavailable')),
      deploy.detail || [
        deploy.publishedAt && 'Published ' + deploy.publishedAt.slice(0, 10),
        deploy.latestState && deploy.latestState !== deploy.state && 'Latest production build ' + deploy.latestState,
      ].filter(Boolean).join(' · '),
    ]);
    const sourceNames = { estimating: 'Estimating feed', dispatch: 'Dispatch feed', ledger: 'Ledger feed', cash: 'Cash balance feed',
      ghl: 'GoHighLevel', twilio: 'Twilio API', make: 'Make API' };
    panel.append(rows([
      ['Balances'],
      ['Twilio balance', money(system.twilio?.balance, system.twilio?.currency), system.twilio?.asOf && 'Checked ' + system.twilio.asOf.slice(0, 10)],
      ['Make credits remaining', number(system.make.balance), [system.make.basis, system.make.allowance != null && number(system.make.allowance) + ' per cycle', system.make.nextReset && 'resets ' + system.make.nextReset].filter(Boolean).join(' · ')],
      ['Make credits used', number(system.make.usage30d), 'API usage over the last 30 days'],
      ['Netlify credits remaining', number(system.netlify.balance), system.netlify.asOf ? system.netlify.basis + ' · read ' + system.netlify.asOf : system.netlify.basis],
      ['Deploys'],
      ...deployRows,
      ['Dispatch'],
      ['Pending syncs', number(system.dispatch?.pendingSyncs)],
      ['Make runs to review', number(system.dispatch?.makeRuns30d.bad), 'Dispatch effects awaiting confirmation or with errors in the past 30 days'],
      ['Data feeds'],
      ...Object.entries(system.sources).map(([name, state]) => [sourceNames[name],
        badge(state.status, state.status === 'ok' ? 'Connected' : state.status === 'setup' ? 'Setup needed' : 'Unavailable'), state.detail]),
    ]));
    return;
  }
  panel.append(node('div', tile.value, 'detail-value'), node('p', report.definitions[tile.key], 'muted'));
  if (tile.key === 'proposals' || tile.key === 'wins') {
    const history = kpis.funnel?.eventHistory;
    panel.append(node('p', history === 'enabled'
      ? 'Event history begins when the workflow is enabled. Earlier stage moves may be missing.'
      : history === 'unavailable' ? 'Event history unavailable. Counts use current pipeline data only.'
        : 'Counts use current pipeline data. Enable event capture to retain future stage changes.', 'muted'));
    if (tile.key === 'wins') wonByPipeline(panel, kpis.pipelines && [...kpis.pipelines, ...(kpis.labor ? [kpis.labor] : [])].sort((a, b) => b.amount - a.amount));
  } else if (tile.key === 'workforce') {
    const wf = kpis.workforce;
    const people = roster();
    const person = people[worker];
    if (person) {
      const card = node('div', undefined, 'person ' + person.status);
      card.append(node('small', person.status === 'booked' ? 'Booked today' : 'Available', 'state'), node('strong', person.name),
        node('span', [person.role, person.job].filter(Boolean).join(' · ') || 'No job today'));
      panel.prepend(card);
    }
    panel.append(rows([
      ['Booked crew', number(wf?.booked ?? wf?.workers), wf ? plural(wf.jobs, 'active job') + ' today' : null],
      ['Available crew', number(wf?.available), wf?.available == null ? 'Labor roster not cached on Dispatch yet. Open the Dispatch board once' : 'Active roster, no job today'],
      ['Pacific date', wf?.asOf || '-'],
    ]));
    for (const [status, title] of [['booked', 'Booked'], ['available', 'Available']]) {
      const group = people.map((p, i) => [p, i]).filter(([p]) => p.status === status);
      if (!group.length) continue;
      panel.append(node('h3', title + ' (' + group.length + ')', 'crew-title ' + status));
      const list = node('ol', undefined, 'crew');
      for (const [c, i] of group) {
        const b = node('button', undefined, 'crew-member ' + status);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(i === worker));
        b.append(node('span', c.name), node('small', c.job || c.role || ''));
        b.addEventListener('click', () => select('workforce', false, i === worker ? null : i));
        const li = node('li'); li.append(b); list.append(li);
      }
      panel.append(list);
    }
    if (people.length) panel.append(node('p', 'Click a worker on the map or in these lists.', 'muted'));
  } else if (tile.key === 'runway') {
    const r = kpis.runway;
    panel.append(rows([['Cash on hand', money(r.cash), r.asOf ? 'As of ' + new Date(r.asOf).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' })
        : system.sources.cash?.status === 'setup' ? 'Connect a live cash balance feed' : 'Live cash balance unavailable'],
      ['Monthly cash burn', money(r.monthlyBurn), r.basis]]));
  } else if (tile.key === 'labor') {
    if (!kpis.labor) { panel.append(node('p', report.system.sources.ghl?.status === 'ok' ? 'No Labor pipeline found in GoHighLevel. Set LABOR_PIPELINE_ID.' : 'GoHighLevel sales unavailable.', 'muted')); return; }
    panel.append(rows([['Jobs won', number(kpis.labor.count)], ['Won jobs missing value', number(kpis.labor.missingValue)], ['Pipeline', kpis.labor.name]]));
    wonByPipeline(panel, [kpis.labor], 'Labor jobs won');
  } else if (tile.key === 'pipelines') {
    const box = node('div', undefined, 'compact');
    pipelineList(box, kpis.pipelines);
    panel.append(box);
  }
}

function mailPanel(panel) {
  const states = {
    loading: 'Checking the mailbox…',
    setup: 'Set MCP_COMMAND_CENTER_TOKEN in Netlify Functions to connect the mailbox.',
    unavailable: 'The mailbox feed is temporarily unavailable.',
  };
  if (mail.status !== 'ok') panel.append(node('p', states[mail.status], 'muted'));
  // Email KPIs from the A2Z Email app for the selected range (null means not available, shown as a dash).
  const e = report?.email;
  if (e) {
    const value = v => v == null ? '-' : number(v);
    panel.append(rows([
      ['Email KPIs for this range'],
      ['Received', value(e.emailsReceived)], ['Sent', value(e.emailsSent)], ['Unanswered actionable', value(e.unansweredActionable)],
      ['New bid invitations', value(e.newBidInvitations)], ['Upcoming bid deadlines', value(e.upcomingBidDeadlines)],
      ['Missed bid deadlines', value(e.missedBidDeadlines)], ['Proposal follow-ups due', value(e.outstandingProposalFollowups)],
      ['Average response', e.averageResponseHours == null ? '-' : e.averageResponseHours + ' h'],
      ['Active GC relationships', value(e.activeGcRelationships)], ['Operational alerts', value(e.operationalAlerts)],
      ['AI requests', value(e.aiRequests), e.estimatedNeurons == null ? null : 'About ' + number(e.estimatedNeurons) + ' Cloudflare neurons'],
      ['Last email sync', e.lastSuccessfulSync ? new Date(e.lastSuccessfulSync).toLocaleString() : '-'],
    ]));
  }
  if (mail.stats) {
    const stats = mail.stats;
    panel.append(rows([
      ['Unread incoming', number(stats.unreadIncoming)],
      ['Bid invitations', number(stats.bidInvitations)],
      ['Urgent unread', number(stats.urgentUnread)],
      ['Awaiting reply', number(stats.awaitingReply)],
      ['Unread invoice mail', number(stats.unreadInvoiceMail)],
    ]));
    panel.append(node('p', 'Recent mail · Last checked ' + new Date(mail.asOf).toLocaleTimeString(), 'muted'));
  }
  const link = node('a', 'Open A2Z Email Inbox');
  link.href = 'https://a2zemails.netlify.app/';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  panel.append(link);
  const queuesButton = node('button', commandCenter.pending ? 'Loading…' : 'Load Command Center');
  queuesButton.type = 'button';
  queuesButton.disabled = Boolean(commandCenter.pending);
  queuesButton.addEventListener('click', loadCommandCenter);
  panel.append(queuesButton);
  if (commandCenter.error) panel.append(node('p', commandCenter.error, 'muted'));
  if (commandCenter.data) {
    const { queues, recent } = commandCenter.data;
    for (const [label, items] of [
      ['Bid deadlines', queues.bids], ['Urgent correspondence', queues.urgent],
      ['Awaiting a reply', queues.unanswered], ['Unread invoice mail', queues.invoices],
      ['Recent activity', recent],
    ]) {
      panel.append(node('h3', label));
      if (!items.length) panel.append(node('p', 'No messages', 'muted'));
      for (const item of items) panel.append(node('p', [item.subject, item.from, item.due].filter(Boolean).join(' · ')));
    }
  }
  const button = node('button', digest.running ? 'Summarizing…' : digest.error && digest.cursor ? 'Resume summary' : 'Summarize mailbox');
  button.type = 'button';
  button.disabled = digest.running;
  button.addEventListener('click', summarizeMailbox);
  const controls = node('div', undefined, 'actions');
  controls.append(button);
  panel.append(controls);
  const status = node('p', digest.error || digest.notice || (digest.count || digest.done ? plural(digest.count, 'message') + ' summarized' : ''), 'muted');
  status.setAttribute('role', 'status');
  panel.append(status);
  if (digest.filteredCount) {
    const filtered = node('details');
    filtered.append(node('summary', 'View filtered (' + digest.filteredCount + ')'));
    for (const item of digest.filtered) filtered.append(node('p', [item.subject, item.from, item.reason].filter(Boolean).join(' · ')));
    if (digest.filteredCount > digest.filtered.length) filtered.append(node('p', 'Showing the latest 200 filtered messages.'));
    panel.append(filtered);
  }
  for (const summary of digest.sections) panel.append(node('p', summary, 'mail-summary'));
}

function refreshMailPanel() {
  if (selected === 'mail' && report) details(tiles().find(tile => tile.key === 'mail'));
}

async function loadCommandCenter() {
  const state = commandCenter = { pending: true };
  refreshMailPanel();
  try {
    const response = await fetch('/api/mail?view=command-center', { headers: authHeaders(), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Command Center is unavailable.');
    state.data = data;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.pending = false;
    if (commandCenter === state) refreshMailPanel();
  }
}

async function summarizeMailbox() {
  if (digest.running) return;
  if (!digest.error || !digest.cursor) digest = { sections: [], count: 0, cursor: null };
  const current = digest;
  current.error = null;
  current.running = true;
  current.cursors ||= new Set();
  refreshMailPanel();
  try {
    let retries = 0;
    do {
      const response = await fetch('/api/mail-summary', {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cursor: current.cursor }),
      });
      if (digest !== current) return;
      const page = await response.json();
      if (digest !== current) return;
      if (response.status === 429 && retries++ < 2) {
        const seconds = Number(response.headers.get('Retry-After')) || 60;
        current.notice = page.error;
        refreshMailPanel();
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        if (digest !== current) return;
        current.notice = null;
        continue;
      }
      if (!response.ok) throw new Error(page.error || 'Mailbox summary unavailable.');
      retries = 0;
      if (page.nextCursor && current.cursors.has(page.nextCursor)) throw new Error('The email app returned a repeated mailbox page.');
      current.count += page.summarized;
      current.filteredCount = (current.filteredCount || 0) + (page.filtered?.length || 0);
      current.filtered = [...(current.filtered || []), ...(page.filtered || [])].slice(-200);
      if (page.summary) current.sections.push(page.summary);
      current.cursor = page.nextCursor;
      if (current.cursor) current.cursors.add(current.cursor);
      refreshMailPanel();
    } while (current.cursor || retries);
    current.done = true;
  } catch (error) {
    current.error = error.message;
  } finally {
    current.running = false;
    if (digest === current) refreshMailPanel();
  }
}

async function updateMail() {
  if (liveMail || !report || report.access?.mailbox === false || document.hidden || $('dashboard').hidden || mailRequest) return;
  const request = new AbortController();
  mailRequest = request;
  let next;
  try {
    const response = await fetch('/api/mail', {
      headers: authHeaders(), signal: request.signal, cache: 'no-store',
    });
    next = response.ok ? await response.json() : { status: response.status === 403 ? 'denied' : 'unavailable' };
  } catch {
    next = { status: 'unavailable' };
  } finally {
    if (mailRequest === request) mailRequest = null;
  }
  if (request.signal.aborted) return;
  applyMail(next);
}

function applyMail(next) {
  if (next.status === 'denied') {
    report.access = { ...report.access, mailbox: false };
    mail = { status: 'loading' };
    previousArrival = previousUnread = null;
    commandCenter = {};
    digest = { sections: [], count: 0, cursor: null };
    select(selected === 'mail' ? null : selected, true, worker);
    return;
  }
  const unread = next.stats?.unreadIncoming;
  const sequence = next.arrivalSequence;
  const growth = previousUnread === null || unread == null ? 0 : unread - previousUnread;
  const arrivals = Math.max(0, sequence == null ? growth : previousArrival === null ? 0 : sequence - previousArrival);
  if (unread != null) previousUnread = unread;
  if (sequence != null) previousArrival = sequence;
  if (next.status === 'setup') { previousUnread = null; previousArrival = null; }
  const updated = next.status === 'unavailable' ? { ...mail, status: next.status } : next;
  const changed = mail.stats?.unreadIncoming !== updated.stats?.unreadIncoming;
  mail = updated;
  noticeMail();
  if (changed) map.update(tiles(), selected);
  refreshMailPanel();
  if (arrivals) map.deliverMail?.(arrivals);
}

let liveMail = false, mailSocket, mailTimer, mailRetry = 1000;
function stopLiveMail() {
  clearTimeout(mailTimer);
  mailTimer = null;
  const socket = mailSocket;
  mailSocket = null;
  socket?.close();
}
function syncLiveMail() {
  if (document.hidden || !report || report.access?.mailbox === false || mailSocket || mailTimer) return;
  if (!liveMail) {
    mailTimer = setTimeout(async () => {
      await updateMail();
      mailTimer = null;
      syncLiveMail();
    }, 30000);
    return;
  }
  const url = new URL('/live', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = mailSocket = new WebSocket(url);
  socket.onopen = () => { mailRetry = 1000; };
  socket.onmessage = event => {
    if (mailSocket !== socket || document.hidden) return;
    const message = JSON.parse(event.data);
    if (message.type === 'mail') applyMail(message.mail);
  };
  socket.onclose = event => {
    if (mailSocket !== socket) return;
    mailSocket = null;
    if (event.code === 1008) { location.replace('/'); return; }
    mailTimer = setTimeout(() => { mailTimer = null; syncLiveMail(); }, mailRetry);
    mailRetry = Math.min(30000, mailRetry * 2);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    mailRequest?.abort();
    stopLiveMail();
  } else {
    if (!liveMail) void updateMail();
    syncLiveMail();
  }
});
window.addEventListener('pagehide', stopLiveMail);
window.addEventListener('pageshow', syncLiveMail);

// fresh: new report data arrived, so rebuild the map.
function select(id, fresh = false, index = null) {
  selected = id;
  worker = id === 'workforce' ? index : null;
  if (!report) return;
  const values = tiles();
  if (id === 'instructions') { if (fresh || !map.select) map.update(values, null); return; }
  const agent = typeof id === 'string' && id.startsWith('agent:') ? cityAgents().find(a => 'agent:' + a.id === id) : null;
  if (id?.startsWith?.('agent:') && !agent) selected = null;
  if (fresh || !map.select) map.update(values, selected);
  else map.select(selected, worker);
  if (agent) agentPanel(agent);
  else details(values.find(tile => tile.key === selected));
}

// ---------------- Jose agents in the city ----------------
// Admin only (same rule as the Jose tab). Each agent is a robot around HQ. Click one to prompt it.
// Chats are saved as normal Jose threads, so they also show in the Jose tab.
const AGENTS = [
  { id: 'main', name: 'Jose', color: '#ffb547', greeting: 'Jose online. Ask anything. I hand it to Email, Systems, Development or one of your bots.' },
  { id: 'email', name: 'Email', color: '#e8aa79', greeting: 'Email agent. Ask about unread mail, bid invitations, invoices and deadlines.', watch: ['mail'] },
  { id: 'systems', name: 'Systems', color: '#7fb2ff', greeting: 'Systems and KPIs. Ask about leads, wins, pipelines, crews, runway or system health.',
    watch: ['leads', 'proposals', 'wins', 'pipelines', 'labor', 'workforce', 'runway', 'system'] },
  { id: 'build', name: 'Development', color: '#46e08a', greeting: 'Development. Describe a dashboard change. I draft a sandbox plan and QC checks it.' },
  { id: 'qc', name: 'QC', color: '#ff6fa8', greeting: 'QC. Ask me to review a plan or a change.' },
  { id: 'gemini', name: 'Gemini', color: '#4f8cff', greeting: 'Gemini. Second opinions, longer writing and general questions, with A2Z numbers as context.' },
  { id: 'cloudflare', name: 'Workers AI', color: '#f6821f', greeting: 'Workers AI on Cloudflare (Llama). Fast drafts, rewrites, brainstorming and a third opinion.' },
];
const BOT_COLORS = ['#c58bff', '#3fe0d0', '#ffd23f', '#ff8a5c'];
const NEW_BOT = { id: 'new', name: '+ New bot', color: '#9aa6bd', ghost: true };
let agentBots = [];
let botsLoaded = false;
const agentChats = new Map();
const notes = [];
const store = {
  get: (name, fallback) => { try { return localStorage.getItem('a2z-' + name) ?? fallback; } catch { return fallback; } },
  set: (name, value) => { try { localStorage.setItem('a2z-' + name, value); } catch { /* storage is optional */ } },
};
let voiceOn = store.get('voice', 'off') === 'on';

function cityAgents({ withGhost = true } = {}) {
  if (report?.access?.admin !== true) return [];
  const bots = agentBots.slice(0, 2).map((bot, i) => ({ id: bot.id, name: bot.name, color: BOT_COLORS[i], greeting: bot.description || 'Custom bot.' }));
  return [...AGENTS.filter(a => a.id !== 'email' || report.access?.mailbox !== false), ...bots,
    ...(withGhost && botsLoaded && bots.length < 2 ? [NEW_BOT] : [])];
}
async function loadAgentBots(force = false) {
  if ((botsLoaded && !force) || report?.access?.admin !== true) return;
  try {
    const response = await fetch('/api/jarvis-memory?role=main', { headers: authHeaders() });
    if (!response.ok) return;
    const data = await response.json();
    agentBots = Array.isArray(data.bots) ? data.bots.filter(bot => /^bot-[a-z0-9-]{2,24}$/.test(bot.id)) : [];
    botsLoaded = true;
    if (report) select(selected, true, worker);
  } catch { /* Bots are optional. Built-in agents still show. */ }
}
function chatFor(id) {
  if (!agentChats.has(id)) agentChats.set(id, { threadId: null, messages: [], busy: false });
  return agentChats.get(id);
}
const agentName = id => cityAgents().find(a => a.id === id)?.name || id;
const firstLine = text => String(text || '').split('\n').map(l => l.replace(/^[-*•#\s]+/, '').replace(/\*\*/g, '').trim()).find(Boolean) || '';

// Voice: browser speech recognition (Chrome, Edge, Safari) and speech synthesis. Nothing leaves the browser except the final text prompt.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function speak(text) {
  if (!voiceOn || !window.speechSynthesis) return Promise.resolve();
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(String(text).replace(/\*\*/g, '').slice(0, 900));
    u.rate = 1.05; u.onend = u.onerror = resolve;
    window.speechSynthesis.speak(u);
  });
}
function listen(input, button) {
  if (!Recognition) return;
  const rec = new Recognition();
  rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1;
  button.classList.add('on'); button.textContent = 'Listening…';
  rec.onresult = event => { input.value = [...event.results].map(r => r[0].transcript).join(' ').slice(0, 1000); };
  rec.onend = () => { button.classList.remove('on'); button.textContent = 'Mic'; if (input.value.trim()) input.form.requestSubmit(); };
  rec.onerror = () => { button.classList.remove('on'); button.textContent = 'Mic'; };
  rec.start();
}

// Proactive notes: compare each refresh with the last one and let the right agent speak up.
let lastSeen = null;
function noticeChanges() {
  if (report?.access?.admin !== true) return;
  const f = report.kpis.funnel || {}, runway = report.kpis.runway?.months, firing = triggered().map(a => a.message);
  const now = { range: report.range.from + '|' + report.range.to, wins: f.wins, proposals: f.proposals, runway, firing, bids: mail.stats?.bidInvitations, urgent: mail.stats?.urgentUnread };
  const was = lastSeen;
  lastSeen = now;
  if (!was || was.range !== now.range) return;
  if (now.wins > was.wins) addNote('main', plural(now.wins - was.wins, 'new win') + '. ' + number(now.wins) + ' this period.');
  if (now.proposals > was.proposals) addNote('systems', plural(now.proposals - was.proposals, 'proposal') + ' sent since last check.');
  if (runway != null && was.runway != null && runway < was.runway - 0.4) addNote('systems', 'Runway dropped to ' + number(runway) + ' months.');
  for (const message of firing.filter(m => !was.firing.includes(m))) addNote('systems', 'Alert: ' + message);
}
function noticeMail() {
  if (report?.access?.admin !== true || !lastSeen) return;
  const bids = mail.stats?.bidInvitations, urgent = mail.stats?.urgentUnread;
  if (bids != null && lastSeen.bids != null && bids > lastSeen.bids) addNote('email', plural(bids - lastSeen.bids, 'new bid invitation') + ' in the inbox.');
  if (urgent != null && lastSeen.urgent != null && urgent > lastSeen.urgent) addNote('email', plural(urgent - lastSeen.urgent, 'new urgent email') + '.');
  lastSeen.bids = bids; lastSeen.urgent = urgent;
}
function addNote(id, text) {
  notes.unshift({ id, text, at: new Date() });
  notes.length = Math.min(notes.length, 12);
  map.agentSay?.(id, text, 15000);
  if (selected === 'agent:' + id) { const agent = cityAgents().find(a => a.id === id); if (agent) agentPanel(agent); }
}

function agentMessage(message, agent) {
  const item = node('div', undefined, 'agent-msg ' + message.role + (message.error ? ' error' : ''));
  for (const line of String(message.content || '').split('\n').map(l => l.trim()).filter(Boolean)) item.append(node('p', line.replace(/\*\*/g, '')));
  if (message.note) item.append(node('small', message.note));
  if (message.plan) item.append(planCard(message, agent));
  if (message.id && message.role === 'assistant' && !message.error) item.append(rateBar(message, agent));
  return item;
}
// Teach from the city: the same feedback the Jose tab sends.
function rateBar(message, agent) {
  const bar = node('div', undefined, 'agent-rate');
  const chat = chatFor(agent.id);
  const send = async (rating, note) => {
    try {
      const response = await fetch('/api/jarvis-memory', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ role: agent.id, action: 'feedback', threadId: chat.threadId, messageId: message.id, rating, ...(note ? { note } : {}) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Feedback not saved.');
      message.rating = rating; message.rated = note ? 'Correction saved. ' + agent.name + ' will use it.' : rating > 0 ? 'Saved as helpful.' : 'Saved.';
    } catch (error) { message.rated = error.message; }
    if (selected === 'agent:' + agent.id) agentPanel(agent);
  };
  if (message.rated) { bar.append(node('small', message.rated)); return bar; }
  const good = node('button', '▲ Helpful'); good.type = 'button';
  const bad = node('button', '▼ Needs work'); bad.type = 'button';
  good.addEventListener('click', () => send(1));
  bad.addEventListener('click', () => {
    const form = node('form', undefined, 'agent-teach');
    const input = node('input'); input.maxLength = 300; input.placeholder = 'What should it do differently?';
    const go = node('button', 'Teach'); go.type = 'submit';
    form.append(input, go);
    form.addEventListener('submit', event => { event.preventDefault(); send(-1, input.value.trim()); });
    bar.replaceChildren(form); input.focus();
  });
  bar.append(good, bad);
  return bar;
}
// Development plans: approve (run in the sandbox) or reject (teaches the agent) right in the city.
function planCard(message, agent) {
  const box = node('div', undefined, 'agent-plan');
  box.append(node('strong', 'Plan: ' + (message.plan.task || 'change')));
  const steps = node('ol');
  for (const step of message.plan.steps || []) steps.append(node('li', step.action + (step.module ? ': ' + step.module : step.sql ? ': ' + step.sql.slice(0, 120) : '')));
  box.append(steps, node('small', message.approved === false ? 'QC rejected this plan.' : message.approved === true ? 'QC approved this plan.' : 'Not reviewed by QC yet.'));
  if (!message.planHash) return box;
  const out = node('div', undefined, 'agent-plan-out');
  if (message.runResult) out.append(node('p', message.runResult));
  const run = node('button', 'Approve and run in sandbox', 'primary'); run.type = 'button';
  const reject = node('button', 'Reject'); reject.type = 'button';
  run.addEventListener('click', async () => {
    if (!confirm('Run this plan in the sandbox? It uses a throwaway copy of A2Z data. Nothing is applied to production.')) return;
    run.disabled = reject.disabled = true;
    map.agentState?.(agent.id, 'busy');
    try {
      const response = await fetch('/api/jarvis-execute', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action: 'run', plan: message.plan, planHash: message.planHash, preset: $('range').value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Sandbox run failed.');
      const passed = (data.checks || []).filter(c => c.ok).length;
      message.runResult = 'Sandbox ' + data.outcome + '. ' + passed + ' of ' + (data.checks || []).length + ' checks passed. Applied to production: no.' + (data.error ? ' ' + data.error : '');
      map.agentState?.(agent.id, data.outcome === 'passed' ? 'done' : 'error');
      map.agentSay?.(agent.id, message.runResult);
    } catch (error) {
      message.runResult = error.message; map.agentState?.(agent.id, 'error');
    }
    if (selected === 'agent:' + agent.id) agentPanel(agent);
  });
  reject.addEventListener('click', () => { message.plan = null; rateBarSend(message, agent, 'Plan rejected from the city view.'); });
  const actions = node('div', undefined, 'agent-actions');
  actions.append(run, reject);
  box.append(actions, out);
  return box;
}
function rateBarSend(message, agent, note) {
  const chat = chatFor(agent.id);
  fetch('/api/jarvis-memory', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ role: agent.id, action: 'feedback', threadId: chat.threadId, messageId: message.id, rating: -1, note }) }).catch(() => {});
  message.rated = 'Plan rejected. ' + agent.name + ' learns from it.';
  if (selected === 'agent:' + agent.id) agentPanel(agent);
}

function agentPanel(agent) {
  if (agent.ghost) return newBotPanel();
  $('detail').hidden = false;
  $('detail-title').textContent = agent.name;
  const panel = $('detail-content');
  panel.replaceChildren();
  const chat = chatFor(agent.id);
  // Alerts this agent is standing on.
  const firing = triggered().filter(a => (agent.watch || []).includes(a.district));
  if (firing.length) {
    const box = node('div', undefined, 'firing');
    box.append(node('strong', firing.length === 1 ? '1 alert I am watching' : firing.length + ' alerts I am watching'));
    for (const a of firing) {
      const ask = node('button', a.message, 'agent-chip'); ask.type = 'button';
      ask.addEventListener('click', () => sendToAgent(agent, 'An alert fired: ' + a.message + '. What is causing it and what should I do today?'));
      box.append(ask);
    }
    panel.append(box);
  }
  const mine = notes.filter(n => n.id === agent.id).slice(0, 3);
  if (mine.length) {
    const box = node('div', undefined, 'agent-notes');
    box.append(node('strong', 'Recent notes'));
    for (const n of mine) box.append(node('small', n.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ' + n.text));
    panel.append(box);
  }
  const log = node('div', undefined, 'agent-log');
  log.setAttribute('aria-live', 'polite');
  log.append(node('p', agent.greeting, 'muted'), ...chat.messages.map(m => agentMessage(m, agent)));
  if (chat.busy) log.append(node('p', agent.name + ' is working…', 'muted thinking'));
  const form = node('form', undefined, 'agent-form');
  const input = node('textarea');
  input.maxLength = 1000; input.rows = 3; input.placeholder = 'Message ' + agent.name; input.setAttribute('aria-label', 'Message ' + agent.name);
  input.disabled = chat.busy;
  const send = node('button', chat.busy ? 'Working…' : 'Send', 'primary'); send.type = 'submit'; send.disabled = chat.busy;
  const fresh = node('button', 'New chat'); fresh.type = 'button'; fresh.disabled = chat.busy || !chat.messages.length;
  const mic = node('button', 'Mic'); mic.type = 'button'; mic.hidden = !Recognition; mic.disabled = chat.busy;
  const voice = node('button', voiceOn ? 'Voice on' : 'Voice off', voiceOn ? 'on' : ''); voice.type = 'button'; voice.hidden = !window.speechSynthesis;
  voice.setAttribute('aria-pressed', String(voiceOn));
  const full = node('a', 'Open in Jose'); full.href = '#jarvis'; full.className = 'agent-link';
  const actions = node('div', undefined, 'agent-actions');
  actions.append(full, node('span'), voice, mic, fresh, send);
  form.append(input, actions);
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', event => { event.preventDefault(); const text = input.value.trim(); if (text) sendToAgent(agent, text); });
  fresh.addEventListener('click', () => { agentChats.delete(agent.id); agentPanel(agent); });
  mic.addEventListener('click', () => listen(input, mic));
  voice.addEventListener('click', () => {
    voiceOn = !voiceOn; store.set('voice', voiceOn ? 'on' : 'off');
    if (!voiceOn) window.speechSynthesis?.cancel();
    agentPanel(agent);
  });
  panel.append(log, form);
  log.scrollTop = log.scrollHeight;
  if (!chat.busy) input.focus({ preventScroll: true });
}
async function postJarvis(body) {
  const response = await fetch('/api/jarvis', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  return { response, data: await response.json().catch(() => ({})) };
}
async function sendToAgent(agent, text) {
  const chat = chatFor(agent.id);
  if (chat.busy) return;
  if (selected !== 'agent:' + agent.id) select('agent:' + agent.id);
  chat.messages.push({ role: 'user', content: text });
  chat.busy = true;
  map.agentState?.(agent.id, 'busy');
  const redraw = () => { if (selected === 'agent:' + agent.id) agentPanel(agent); };
  redraw();
  try {
    const body = { role: agent.id, prompt: text, preset: $('range').value, ...(chat.threadId ? { threadId: chat.threadId } : { newThread: true }) };
    let { response, data } = await postJarvis(body);
    if (response.status === 404 && body.threadId) {
      delete body.threadId; body.newThread = true;
      ({ response, data } = await postJarvis(body));
    }
    if (!response.ok) throw new Error(data.error || 'Jose request failed (HTTP ' + response.status + ').');
    if (data.threadId) chat.threadId = data.threadId;
    // Delegation: a packet flies out to each agent in the trace, then the answer flies back.
    const trace = [agent.id, ...(data.trace || []).filter(id => id !== agent.id && id !== 'execute')];
    let delay = 0;
    for (let i = 0; i < trace.length - 1; i++) { map.agentFlow?.(trace[i], trace[i + 1], delay); map.agentState?.(trace[i + 1], 'busy'); delay += 0.9; }
    for (let i = trace.length - 1; i > 0; i--) { map.agentFlow?.(trace[i], trace[i - 1], delay); delay += 0.9; }
    const route = trace.slice(1).map(agentName);
    const message = { id: data.messageId, role: 'assistant', content: data.answer || data.error || 'No answer.',
      note: [route.length ? 'Via ' + route.join(' > ') : '', data.memoryError || ''].filter(Boolean).join(' · '),
      plan: data.plan && data.planHash && data.validation?.ok !== false ? data.plan : null, planHash: data.planHash, approved: data.approved };
    setTimeout(() => {
      chat.messages.push(message);
      for (const id of trace.slice(1)) map.agentState?.(id, 'done');
      map.agentState?.(agent.id, 'done');
      map.agentSay?.(agent.id, message.plan ? 'Plan ready. Click me to approve or reject it.' : firstLine(message.content));
      speak(message.content);
      chat.busy = false;
      redraw();
    }, delay * 1000);
    return;
  } catch (error) {
    chat.messages.push({ role: 'assistant', content: error.message || 'Jose request failed.', error: true });
    map.agentState?.(agent.id, 'error');
    map.agentSay?.(agent.id, error.message || 'Request failed.');
  }
  chat.busy = false;
  redraw();
}

// "Ask Jose about this" on every district panel.
function askAbout(tile) {
  const main = cityAgents().find(a => a.id === 'main');
  if (!main || !tile) return null;
  const button = node('button', 'Ask Jose about this', 'agent-ask'); button.type = 'button';
  button.addEventListener('click', () => {
    const firing = triggered().filter(a => a.district === tile.key).map(a => a.message);
    const facts = [tile.value, tile.sub].filter(Boolean).join(', ');
    const prompt = 'Look at ' + tile.title + ' on the dashboard' + (facts ? ' (' + facts + ')' : '') + ' for ' + $('range').selectedOptions[0].text.toLowerCase() + '.'
      + (firing.length ? ' Alerts firing: ' + firing.join('; ') + '.' : '') + ' What stands out and what should I do today?';
    sendToAgent(main, prompt.slice(0, 1000));
  });
  return button;
}

// Morning briefing: Systems writes one line per district, then the camera tours them while the robot reads each line.
const TOUR = ['hq', 'leads', 'proposals', 'wins', 'pipelines', 'labor', 'workforce', 'runway', 'system', 'mail'];
let briefing = null;
async function runBriefing() {
  if (briefing) { briefing.stop = true; return; }
  const systems = cityAgents().find(a => a.id === 'systems');
  if (!systems) return;
  const run = briefing = { stop: false };
  $('brief').textContent = 'Stop briefing';
  map.agentState?.('systems', 'busy');
  map.agentSay?.('systems', 'Pulling this morning\'s numbers…', 20000);
  try {
    const keys = TOUR.filter(k => k !== 'mail' || report.access?.mailbox !== false);
    const { response, data } = await postJarvis({ role: 'systems', preset: $('range').value,
      prompt: 'Morning briefing. Write exactly one short line for each of these keys, in this order, formatted as key: line. Keys: ' + keys.join(', ') + '. hq is the overall headline. Use numbers. No other text.' });
    if (!response.ok) throw new Error(data.error || 'Briefing failed.');
    map.agentState?.('systems', 'done');
    const lines = Object.fromEntries(String(data.answer || '').split('\n').map(l => l.replace(/^[-*•\s]+/, '').match(/^([a-z]+)\s*:\s*(.+)$/i)).filter(Boolean).map(m => [m[1].toLowerCase(), m[2].replace(/\*\*/g, '').trim()]));
    if (!keys.some(key => lines[key])) map.agentSay?.('systems', firstLine(data.answer) || 'No briefing lines came back.', 12000);
    for (const key of keys) {
      if (run.stop || !lines[key]) continue;
      select(key);
      map.agentSay?.('systems', lines[key], 9000);
      await Promise.all([speak(lines[key]), new Promise(r => setTimeout(r, 4200))]);
    }
    store.set('briefed', new Date().toLocaleDateString('en-CA'));
  } catch (error) {
    map.agentState?.('systems', 'error'); map.agentSay?.('systems', error.message);
  } finally {
    briefing = null;
    $('brief').textContent = 'Brief me';
    if (!run.stop) { select(null); map.reset(); }
  }
}
function autoBrief() {
  if (!$('daily').checked || briefing || report?.access?.admin !== true) return;
  const today = new Date().toLocaleDateString('en-CA');
  if (store.get('briefed', '') !== today && new Date().getHours() >= 5) runBriefing();
}

// Custom instructions for every agent, opened from the city.
function instructionsPanel() {
  selected = 'instructions';
  $('detail').hidden = false;
  $('detail-title').textContent = 'Custom instructions';
  const form = instructionsForm({ headers: authHeaders, onSaved: () => map.agentSay?.('main', 'Got it. I will follow your new instructions.') });
  $('detail-content').replaceChildren(form);
  form.load();
}

// Custom bots from the city: the ghost robot opens this form.
function newBotPanel() {
  $('detail').hidden = false;
  $('detail-title').textContent = 'Create a bot';
  const panel = $('detail-content');
  panel.replaceChildren(node('p', 'Give it a job. Jose will hand it matching requests, and it gets its own robot in the city.', 'muted'));
  const form = node('form', undefined, 'agent-form');
  const name = node('input'); name.maxLength = 40; name.required = true; name.placeholder = 'Name, e.g. Bid Coach';
  const description = node('input'); description.maxLength = 200; description.placeholder = 'What it is for (Jose uses this to delegate)';
  const instructions = node('textarea'); instructions.maxLength = 1500; instructions.required = true; instructions.rows = 4; instructions.placeholder = 'Instructions for this bot';
  const context = node('select');
  context.append(new Option('A2Z metrics', 'metrics'), new Option('Mailbox snapshot', 'mail'), new Option('No data', 'none'));
  const status = node('p', '', 'muted');
  const create = node('button', 'Create bot', 'primary'); create.type = 'submit';
  form.append(name, description, instructions, context, create, status);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    create.disabled = true; status.textContent = 'Creating…';
    try {
      const response = await fetch('/api/jarvis-memory', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ role: 'main', action: 'bot-create', bot: { name: name.value.trim(), description: description.value.trim(), instructions: instructions.value.trim(), context: context.value } }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Bot not created.');
      await loadAgentBots(true);
      if (data.bot?.id) { select('agent:' + data.bot.id); map.agentSay?.(data.bot.id, 'Hi, I am ' + data.bot.name + '. Ask me anything in my lane.'); }
    } catch (error) { status.textContent = error.message; create.disabled = false; }
  });
  panel.append(form);
  name.focus({ preventScroll: true });
}

async function refresh() {
  pending?.abort();
  const current = new AbortController();
  pending = current;
  $('refresh').disabled = true;
  $('status').textContent = 'Refreshing…';
  $('status').dataset.state = 'busy';
  try {
    if (highlevelMode) await signInHighLevel();
    if (current.signal.aborted) return;
    const response = await fetch('/api/metrics?preset=' + encodeURIComponent($('range').value), {
      headers: authHeaders(), signal: current.signal,
    });
    if (current.signal.aborted) return;
    if (response.status === 401) {
      if (response.headers.get('X-A2Z-Login') === 'required') { location.replace('/'); return; }
      stopLiveMail();
      report = null;
      mailRequest?.abort();
      mailRequest = null;
      mail = { status: 'loading' };
      previousUnread = null;
      previousArrival = null;
      commandCenter = {};
      digest = { sections: [], count: 0, cursor: null };
      key = '';
      if (highlevelMode) highlevelSession = null;
      else sessionStorage.removeItem('a2z-key');
      $('key').value = '';
      $('dashboard').hidden = true;
      $('auth').hidden = highlevelMode;
      $('status').textContent = highlevelMode ? 'HighLevel session expired. Select Refresh to sign in again.' : 'Access key required';
      $('status').dataset.state = 'error';
      return;
    }
    if (!response.ok) throw new Error('Report unavailable');
    const next = await response.json();
    if (current.signal.aborted) return;
    const firstLoad = !report;
    const hadMailbox = report?.access?.mailbox !== false;
    report = next;
    const useLiveMail = response.headers.get('X-A2Z-Live') === 'websocket';
    if (useLiveMail !== liveMail || report.access?.mailbox === false) stopLiveMail();
    liveMail = useLiveMail;
    syncLiveMail();
    if (report.access?.mailbox === false) {
      mailRequest?.abort();
      mail = { status: 'loading' };
      previousArrival = previousUnread = null;
      commandCenter = {};
      digest = { sections: [], count: 0, cursor: null };
      if (selected === 'mail') selected = null;
    }
    if (highlevelMode) {
      $('nav-settings').hidden = $('nav-health').hidden = $('nav-jarvis').hidden = report.access?.admin !== true;
      if (report.access?.admin !== true && ($('settings').hidden === false || $('health').hidden === false || $('jarvis').hidden === false)) route();
    }
    $('auth').hidden = true;
    $('dashboard').hidden = false;
    const { mode, range } = report;
    const dates = range.from === range.to ? range.from : range.from + ' to ' + range.to;
    $('status').textContent = (mode === 'sample' ? 'Sample data · ' : '') + dates + ' · Pacific';
    $('status').dataset.state = mode === 'sample' ? 'sample' : 'live';
    alertBadge();
    select(selected, true, worker);
    loadAgentBots();
    for (const id of ['brief', 'instructions', 'daily-label']) $(id).hidden = report.access?.admin !== true;
    noticeChanges();
    autoBrief();
    lastLoad = Date.now();
    if (firstLoad || !hadMailbox) updateMail();
  } catch (error) {
    if (!current.signal.aborted) {
      if (highlevelMode && !highlevelSession) {
        $('status').textContent = error.message || 'HighLevel sign-in failed.';
        $('status').dataset.state = 'error';
        return;
      }
      $('status').textContent = report ? 'Refresh failed · showing ' + report.range.from + ' to ' + report.range.to : 'Report unavailable';
      $('status').dataset.state = 'error';
    }
  } finally {
    if (pending === current) $('refresh').disabled = false;
  }
}
$('controls').addEventListener('submit', event => { event.preventDefault(); refresh(); });
$('range').addEventListener('change', refresh);
// Polling that stays cheap: one request per refresh, every 2 minutes while someone is using the page,
// every 10 minutes when idle, and none while the tab is hidden. The city animates between refreshes on its own.
let lastLoad = 0, lastInput = Date.now();
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, () => { lastInput = Date.now(); }, { passive: true });
function due() { return Date.now() - lastInput < 10 * 60000 ? 2 * 60000 : 10 * 60000; }
let reportTimer;
function scheduleReport() {
  clearTimeout(reportTimer);
  if (document.hidden) return;
  reportTimer = setTimeout(() => {
    if (report && Date.now() - lastLoad >= due()) void refresh();
    scheduleReport();
  }, Math.max(15000, report ? due() - (Date.now() - lastLoad) : 120000));
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && report && Date.now() - lastLoad >= 2 * 60000) void refresh();
  scheduleReport();
});
scheduleReport();
$('signin').addEventListener('submit', event => {
  event.preventDefault();
  key = $('key').value.trim();
  $('key').value = '';
  sessionStorage.setItem('a2z-key', key);
  refresh().then(() => { if (!$('settings').hidden) loadAlerts(); });
});
$('reset').addEventListener('click', () => { select(null); map.reset(); });
$('brief').addEventListener('click', () => runBriefing());
$('instructions').addEventListener('click', () => instructionsPanel());
$('daily').checked = store.get('daily', 'off') === 'on';
$('daily').addEventListener('change', () => { store.set('daily', $('daily').checked ? 'on' : 'off'); if ($('daily').checked) autoBrief(); });
$('close').addEventListener('click', () => select(null));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && selected) select(null); });

const filterForm = $('mail-filter-form');
async function loadMailFilterSettings(method, body) {
  const button = filterForm.querySelector('button');
  const status = $('mail-filter-status');
  button.disabled = true;
  status.textContent = method === 'GET' ? 'Loading filters' : 'Saving filters';
  try {
    const response = await fetch('/api/mail-filters', {
      method, body, headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    });
    const filters = await response.json();
    if (!response.ok) throw new Error(filters.error);
    $('mail-filter-allow').value = filters.allowlist.join('\n');
    $('mail-filter-block').value = filters.blocklist.join('\n');
    status.textContent = method === 'PUT' ? 'Filters saved' : '';
    button.disabled = false;
  } catch (error) {
    status.textContent = error.message || 'Mail filter settings are unavailable.';
    button.disabled = method === 'GET';
  }
}
$('mail-filter-settings').addEventListener('toggle', event => {
  if (event.target.open) void loadMailFilterSettings('GET');
});
filterForm.addEventListener('submit', event => {
  event.preventDefault();
  const entries = id => $(id).value.split(/[,\n]/).map(entry => entry.trim()).filter(Boolean);
  void loadMailFilterSettings('PUT', JSON.stringify({
    allowlist: entries('mail-filter-allow'),
    blocklist: entries('mail-filter-block'),
  }));
});

// ---------------- alerts ----------------
function triggered() { return report?.alerts || alertView?.alerts || []; }
function alertDistricts() {
  return [...new Set(triggered().map(a => a.district))];
}
function alertBadge() {
  const n = triggered().length;
  $('alert-count').hidden = !n;
  $('alert-count').textContent = n;
}
async function loadAlerts() {
  try {
    const response = await fetch('/api/alerts', { headers: authHeaders() });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Alerts unavailable');
    alertView = await response.json();
  } catch (error) {
    alertView = null;
    $('alert-status').textContent = error.message;
  }
  if (report && alertView) report.alerts = alertView.alerts;
  alertBadge();
  if (report) select(selected, true, worker);
  if (!$('settings').hidden) renderSettings();
}

const conditions = { number: [['above', 'Above'], ['below', 'Below']], status: [['not_ok', 'Not healthy']] };
const periods = [['today', 'Today'], ['wtd', 'This week'], ['mtd', 'This month'], ['30d', 'Last 30 days'], ['ytd', 'This year']];
function options(select, list, value) {
  for (const [v, label] of list) { const o = node('option', label); o.value = v; o.selected = v === value; select.append(o); }
  return select;
}
function renderSettings() {
  const rules = $('rules');
  rules.replaceChildren();
  if (!alertView) return;
  const { settings, metrics, alerts, canEdit } = alertView;
  $('webhook').value = settings.webhookUrl;
  $('cooldown').value = settings.cooldownMinutes;
  $('alerts-on').checked = settings.enabled;
  $('alerts-fixed').checked = settings.notifyRecovery !== false;
  const billing = settings.billing || {};
  $('netlify-credits').value = billing.netlifyCreditsRemaining ?? '';
  $('netlify-asof').value = billing.netlifyCreditsAsOf || '';
  $('make-cycle').value = billing.makeCycleCredits ?? '';
  for (const el of $('alert-form').elements) el.disabled = !canEdit;
  if (!canEdit) $('alert-status').textContent = 'Read only. Unlock with the dashboard key to save or send.';
  const firing = new Set(alerts.map(a => a.id));
  const groups = [...new Set(metrics.map(m => m.group))];
  for (const group of groups) {
    const card = node('section', undefined, 'surface rule-group');
    card.append(node('h2', group));
    const head = node('div', undefined, 'rule head');
    for (const label of ['On', 'Metric', 'Now', 'Condition', 'Threshold', 'Period', 'Checks']) head.append(node('span', label));
    card.append(head);
    for (const m of metrics.filter(x => x.group === group)) {
      const rule = settings.rules[m.key] || { enabled: false, op: conditions[m.kind][0][0], threshold: null, preset: 'mtd' };
      const row = node('div', undefined, 'rule' + (firing.has(m.key) ? ' firing' : ''));
      row.dataset.key = m.key;
      row.style.setProperty('--c', colors[m.district] || '#e6b072');
      const on = node('input'); on.type = 'checkbox'; on.checked = rule.enabled; on.name = 'enabled'; on.setAttribute('aria-label', 'Alert on ' + m.label);
      const name = node('span', m.label, 'metric');
      const value = node('span', m.valueText, 'now');
      const op = options(node('select'), conditions[m.kind], rule.op); op.name = 'op'; op.setAttribute('aria-label', 'Condition');
      const threshold = node('input'); threshold.type = 'number'; threshold.step = 'any'; threshold.name = 'threshold';
      threshold.value = rule.threshold ?? ''; threshold.setAttribute('aria-label', 'Threshold'); threshold.hidden = m.kind === 'status';
      const preset = options(node('select'), periods, rule.preset); preset.name = 'preset'; preset.setAttribute('aria-label', 'Period'); preset.hidden = !m.period;
      const wait = node('input'); wait.type = 'number'; wait.min = '1'; wait.max = '12'; wait.step = '1'; wait.name = 'wait';
      wait.value = rule.wait || 1; wait.setAttribute('aria-label', 'Checks in a row before alert'); wait.title = 'Checks in a row (15 min each) before the alert sends';
      for (const el of [on, op, threshold, preset, wait]) el.disabled = !canEdit;
      const t = node('span'); t.append(threshold);
      const p = node('span'); p.append(preset);
      const w = node('span'); w.append(wait);
      row.append(on, name, value, op, t, p, w);
      card.append(row);
    }
    rules.append(card);
  }
}
function readSettings() {
  const rules = {};
  for (const row of $('rules').querySelectorAll('.rule[data-key]')) {
    const get = n => row.querySelector(`[name="${n}"]`);
    const enabled = get('enabled').checked, op = get('op').value, threshold = get('threshold').value;
    if (!enabled && threshold === '') continue;
    if (enabled && op !== 'not_ok' && threshold === '') throw new Error('Add a threshold for ' + row.querySelector('.metric').textContent);
    rules[row.dataset.key] = { enabled, op, threshold: threshold === '' ? null : Number(threshold), preset: get('preset').value, wait: Number(get('wait').value) || 1 };
  }
  const billing = { netlifyCreditsRemaining: $('netlify-credits').value, netlifyCreditsAsOf: $('netlify-asof').value || (($('netlify-credits').value !== '') ? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : ''),
    makeCycleCredits: $('make-cycle').value };
  return { webhookUrl: $('webhook').value.trim(), cooldownMinutes: Number($('cooldown').value), enabled: $('alerts-on').checked, notifyRecovery: $('alerts-fixed').checked, rules, billing };
}
async function alertRequest(method, body, done) {
  $('alert-status').textContent = 'Working…';
  try {
    const response = await fetch('/api/alerts', { method, headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    $('alert-status').textContent = done(data);
    return data;
  } catch (error) {
    $('alert-status').textContent = error.message;
  }
}
$('alert-form').addEventListener('submit', async event => {
  event.preventDefault();
  let body;
  try { body = readSettings(); } catch (error) { $('alert-status').textContent = error.message; return; }
  if (await alertRequest('PUT', body, () => 'Saved.')) await loadAlerts().then(() => { $('alert-status').textContent = 'Saved.'; });
});
$('test').addEventListener('click', () => alertRequest('POST', { action: 'test' }, d => 'Test sent with ' + d.sent + (d.sent === 1 ? ' alert.' : ' alerts.')));
$('check').addEventListener('click', () => alertRequest('POST', { action: 'check' }, d => d.skipped || d.error
  || (d.sent ? 'Sent ' + d.sent + ' new alert' + (d.sent === 1 ? '.' : 's.') : d.triggered ? d.triggered + ' triggered, all inside cooldown.' : 'Nothing triggered.')));

function route() {
  const canAdmin = !highlevelMode || report?.access?.admin === true;
  const view = canAdmin && location.hash === '#settings' ? 'settings' : canAdmin && location.hash === '#health' ? 'health' : canAdmin && location.hash === '#jarvis' ? 'jarvis' : 'city';
  $('brain').hidden = view !== 'city';
  $('settings').hidden = view !== 'settings';
  $('health').hidden = view !== 'health';
  $('jarvis').hidden = view !== 'jarvis';
  for (const [id, on] of [['nav-city', view === 'city'], ['nav-settings', view === 'settings'], ['nav-health', view === 'health'], ['nav-jarvis', view === 'jarvis']]) on ? $(id).setAttribute('aria-current', 'page') : $(id).removeAttribute('aria-current');
  if (view === 'settings') { renderSettings(); loadAlerts(); }
  if (view === 'health') loadHealth();
  if (view === 'jarvis') loadJarvis();
}

// Jose loads on first visit so the city view stays as light as before.
let jarvisPanel = null;
async function loadJarvis() {
  try {
    jarvisPanel ||= (await import('./jarvis.mjs')).createJarvisPanel({ headers: authHeaders, preset: () => $('range').value });
    if (!jarvisPanel.isConnected) $('jarvis').replaceChildren(jarvisPanel);
    jarvisPanel.load();
  } catch {
    $('jarvis').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Jose is available on the deployed site or with npm run sandbox.' }));
  }
}

// ---------------- diagnostics ----------------
let healthBusy = false;
const healthTone = s => ({ ok: 'ok', setup: 'warn' }[s] || 'bad');
const ago = iso => { if (!iso) return 'never'; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
async function loadHealth(fresh = false) {
  if (healthBusy) return;
  healthBusy = true;
  $('health-fresh').disabled = true;
  $('health-summary').textContent = fresh ? 'Reading every source fresh…' : 'Loading…';
  try {
    const response = await fetch('/api/diagnostics' + (fresh ? '?fresh=1' : ''), { headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Diagnostics unavailable');
    renderHealth(data);
  } catch (error) {
    $('health-summary').textContent = error.message;
  } finally {
    healthBusy = false;
    $('health-fresh').disabled = false;
  }
}
function renderHealth(d) {
  const tally = { ok: 0, warn: 0, bad: 0 };
  for (const c of d.checks) tally[healthTone(c.status)]++;
  $('health-count').hidden = !tally.bad;
  $('health-count').textContent = tally.bad;
  $('health-summary').textContent = (d.fresh ? 'Fresh check' : 'Cached ' + (d.cache.ageSeconds ?? 0) + 's ago (refreshes every ' + d.cache.ttlSeconds + 's)')
    + ' · ' + d.totalMs + ' ms · ' + (d.mode === 'sample' ? 'sample data' : 'live');
  const overview = $('health-overview');
  overview.replaceChildren();
  for (const [tone, label] of [['ok', 'Healthy'], ['warn', 'Needs setup'], ['bad', 'Failing']]) {
    const card = node('div', undefined, 'surface stat ' + tone);
    card.append(node('strong', String(tally[tone])), node('span', label));
    overview.append(card);
  }
  const box = $('health-checks');
  box.replaceChildren();
  for (const group of [...new Set(d.checks.map(c => c.group))]) {
    const card = node('section', undefined, 'surface rule-group');
    card.append(node('h2', group));
    const list = node('div', undefined, 'checks');
    for (const c of d.checks.filter(x => x.group === group).sort((a, b) => ['bad', 'warn', 'ok'].indexOf(healthTone(a.status)) - ['bad', 'warn', 'ok'].indexOf(healthTone(b.status)))) {
      const row = node('div', undefined, 'check ' + healthTone(c.status));
      const head = node('div', undefined, 'check-head');
      head.append(node('span', c.label, 'check-name'), badge(c.status, c.status === 'ok' ? 'Healthy' : c.status === 'setup' ? 'Setup needed' : 'Failing'));
      row.append(head);
      if (c.detail) row.append(node('p', c.detail, 'check-detail'));
      const meta = node('div', undefined, 'check-meta');
      if (c.ms != null) meta.append(node('span', c.ms + ' ms', c.ms > 4000 ? 'slow' : ''));
      meta.append(node('span', 'Checked ' + ago(c.checkedAt)));
      for (const [k, v] of Object.entries(c.records || {})) if (v != null) meta.append(node('span', k.replace(/([A-Z])/g, ' $1').toLowerCase() + ': ' + (typeof v === 'number' ? number(v) : v)));
      row.append(meta);
      list.append(row);
    }
    card.append(list);
    box.append(card);
  }
  const config = $('health-config');
  config.replaceChildren();
  for (const [name, vars] of Object.entries(d.config)) {
    const item = node('div', undefined, 'config');
    item.append(node('strong', name));
    const chips = node('div', undefined, 'chips');
    for (const [v, set] of Object.entries(vars)) chips.append(node('span', v, 'chip ' + (set ? 'set' : 'missing')));
    item.append(chips);
    config.append(item);
  }
  const r = d.runtime;
  $('health-runtime').textContent = ['Node ' + r.node, r.context && 'context ' + r.context, r.commit && 'commit ' + r.commit, 'generated ' + new Date(d.generatedAt).toLocaleTimeString('en-US')].filter(Boolean).join(' · ');
}
$('health-fresh').addEventListener('click', () => loadHealth(true));
// While Diagnostics is open, re-read the cached view every minute. A fresh read only happens on the button.
setInterval(() => { if (!$('health').hidden && !document.hidden) loadHealth(); }, 60000);
window.addEventListener('hashchange', route);
refresh().then(route);
