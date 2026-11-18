import { setupMap, stations } from './map.js';

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

let report;
let selected = null;
let alertView = null;
let worker = null;
let pending;
let mail = { status: 'loading' };
let previousUnread = null;
let previousArrival = null;
let digest = { sections: [], count: 0, cursor: null };
let mailRequest;
const map = window.A2ZCity?.supported() ? city3d() : setupMap($('city'), $('stations'), id => select(id, true));

function city3d() {
  $('city').hidden = true;
  $('stations').hidden = true;
  $('map').classList.add('live');
  const view = window.A2ZCity.mount($('map'), { onSelect: (id, index) => select(id, false, index ?? null) });
  return { update: (values, id) => { view.update(report, values, palette, alertDistricts()); view.select(id, worker, false); }, reset: view.reset, select: view.select, deliverMail: view.deliverMail };
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
  const button = node('button', digest.running ? 'Summarizing…' : digest.error && digest.cursor ? 'Resume summary' : 'Summarize mailbox');
  button.type = 'button';
  button.disabled = digest.running || (!mail.stats && !digest.error);
  button.addEventListener('click', summarizeMailbox);
  const controls = node('div', undefined, 'actions');
  controls.append(button);
  panel.append(controls);
  const status = node('p', digest.error || digest.notice || (digest.count || digest.done ? plural(digest.count, 'message') + ' summarized' : ''), 'muted');
  status.setAttribute('role', 'status');
  panel.append(status);
  for (const summary of digest.sections) panel.append(node('p', summary, 'mail-summary'));
}

function refreshMailPanel() {
  if (selected === 'mail' && report) details(tiles().find(tile => tile.key === 'mail'));
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
  if (!report || report.access?.mailbox === false || document.hidden || $('dashboard').hidden || mailRequest) return;
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
  if (next.status === 'denied') {
    report.access = { ...report.access, mailbox: false };
    mail = { status: 'loading' };
    previousArrival = previousUnread = null;
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
  if (changed) map.update(tiles(), selected);
  refreshMailPanel();
  if (arrivals) map.deliverMail?.(arrivals);
}

setInterval(updateMail, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateMail(); });

// fresh: new report data arrived, so rebuild the map.
function select(id, fresh = false, index = null) {
  selected = id;
  worker = id === 'workforce' ? index : null;
  if (!report) return;
  const values = tiles();
  if (fresh || !map.select) map.update(values, selected);
  else map.select(id, worker);
  details(values.find(tile => tile.key === selected));
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
      report = null;
      mailRequest?.abort();
      mailRequest = null;
      mail = { status: 'loading' };
      previousUnread = null;
      previousArrival = null;
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
    if (report.access?.mailbox === false) {
      mailRequest?.abort();
      mail = { status: 'loading' };
      previousArrival = previousUnread = null;
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
setInterval(() => { if (!document.hidden && report && Date.now() - lastLoad >= due()) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && report && Date.now() - lastLoad >= 2 * 60000) refresh(); });
$('signin').addEventListener('submit', event => {
  event.preventDefault();
  key = $('key').value.trim();
  $('key').value = '';
  sessionStorage.setItem('a2z-key', key);
  refresh().then(() => { if (!$('settings').hidden) loadAlerts(); });
});
$('reset').addEventListener('click', () => { select(null); map.reset(); });
$('close').addEventListener('click', () => select(null));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && selected) select(null); });

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
    for (const label of ['On', 'Metric', 'Now', 'Condition', 'Threshold', 'Period']) head.append(node('span', label));
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
      for (const el of [on, op, threshold, preset]) el.disabled = !canEdit;
      const t = node('span'); t.append(threshold);
      const p = node('span'); p.append(preset);
      row.append(on, name, value, op, t, p);
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
    rules[row.dataset.key] = { enabled, op, threshold: threshold === '' ? null : Number(threshold), preset: get('preset').value };
  }
  const billing = { netlifyCreditsRemaining: $('netlify-credits').value, netlifyCreditsAsOf: $('netlify-asof').value || (($('netlify-credits').value !== '') ? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : ''),
    makeCycleCredits: $('make-cycle').value };
  return { webhookUrl: $('webhook').value.trim(), cooldownMinutes: Number($('cooldown').value), enabled: $('alerts-on').checked, rules, billing };
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

// JARVIS loads on first visit so the city view stays as light as before.
let jarvisPanel = null;
async function loadJarvis() {
  try {
    jarvisPanel ||= (await import('./jarvis.mjs')).createJarvisPanel({ headers: authHeaders, preset: () => $('range').value });
    if (!jarvisPanel.isConnected) $('jarvis').replaceChildren(jarvisPanel);
    jarvisPanel.load();
  } catch {
    $('jarvis').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'JARVIS is available on the deployed site or with npm run sandbox.' }));
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
