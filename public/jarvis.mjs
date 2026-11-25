import { mountTopics } from './jarvis-topics.mjs';
// A2Z Jose panel: per-agent saved chats, learning, company memory, custom bots and the execution sandbox.
// Text nodes only. No inline styles (the site CSP is style-src 'self').
const builtins = { main: 'Main (delegates)', email: 'Email', systems: 'Systems and KPIs', build: 'Development + QC', qc: 'QC', gemini: 'Gemini', cloudflare: 'Workers AI' };
const greetings = {
  main: 'Jose online. Ask anything. I will hand it to Email, Systems, Development or one of your bots.',
  email: 'Email agent online. Ask about unread mail, bid invitations, invoices and deadlines.',
  systems: 'Systems and KPIs online. Ask about leads, wins, pipelines, crews, runway or system health.',
  build: 'Development online. Describe a dashboard change. I draft a sandbox plan and QC checks it before you run it.',
  qc: 'QC online. Paste a plan with /execute first, or ask me to review a change.',
  gemini: 'Gemini online. Second opinions, longer writing and general questions, with A2Z numbers as context.',
  cloudflare: 'Workers AI online (Cloudflare, Llama). Fast drafts, rewrites, brainstorming and a third opinion.',
};
const suggestions = {
  main: ['What needs my attention today?', 'Any bid invitations in the inbox?'],
  email: ['Summarize unread mail and flag deadlines.', 'Which emails are waiting on a reply?'],
  systems: ['Review KPI changes and give me the top three actions.', 'Which data source has the weakest coverage?'],
  build: ['Build a view of won value by pipeline and bind it to the pipelines module.'],
  qc: ['What should a good execution plan include?'],
  gemini: ['Give me a second opinion on this month\'s numbers.', 'Draft a follow-up email for a bid we sent last week.'],
  cloudflare: ['Brainstorm 5 ways to win more container sales.', 'Rewrite this bid follow-up to sound friendlier.'],
};
const traceNames = { estimating: 'Estimating', main: 'Main', email: 'Email', systems: 'Systems and KPIs', build: 'Development', qc: 'QC', gemini: 'Gemini', cloudflare: 'Workers AI', execute: 'Execute (validation only)' };
const sourceLabels = { manual: 'Instruction', correction: 'Correction', praise: 'Keep doing' };
const pct = value => (value === null || value === undefined ? 'n/a' : Math.round(value * 100) + '%');

function node(tag, properties = {}, ...children) {
  const result = Object.assign(document.createElement(tag), properties);
  result.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return result;
}
function inline(text) {
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match; (match = pattern.exec(text));) {
    parts.push(text.slice(last, match.index), node('strong', {}, match[1]));
    last = pattern.lastIndex;
  }
  parts.push(text.slice(last));
  return parts.filter(part => part !== '');
}
function formatted(text) {
  const box = node('div', { className: 'jarvis-text' });
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /^\s*\d/.test(line);
      if (!list || (list.tagName === 'OL') !== ordered) box.append(list = node(ordered ? 'ol' : 'ul'));
      list.append(node('li', {}, ...inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    box.append(node('p', heading ? { className: 'jarvis-heading' } : {}, ...inline(heading ? heading[1] : line)));
  }
  return box;
}
function table(rows) {
  if (!rows?.length) return null;
  const cols = Object.keys(rows[0]);
  return node('div', { className: 'jarvis-table' }, node('table', {},
    node('thead', {}, node('tr', {}, ...cols.map(c => node('th', {}, c)))),
    node('tbody', {}, ...rows.map(row => node('tr', {}, ...cols.map(c => node('td', {}, row[c] === null ? '' : String(row[c]))))))));
}

import { instructionsForm } from './instructions.mjs';
import { estimatingBooking } from './estimating-booking.mjs';

export function createJarvisPanel({ headers, preset = () => 'mtd' }) {
  let role = 'main', threadId = null, messages = [], threads = [], learned = null, shared = [], bots = [], busy = false, loadToken = 0, query = '';

  async function call(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: headers(options.body ? { 'Content-Type': 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'Jose request failed.'), { status: response.status, result });
    return result;
  }
  const memoryCall = (body, target = role) => call('/api/jarvis-memory', { method: 'POST', body: { role: target, ...body } });
  const nameOf = id => builtins[id] || bots.find(bot => bot.id === id)?.name || id;

  const roleSelect = node('select', { id: 'jarvis-agent', ariaLabel: 'Agent' });
  const badge = node('span', { className: 'pill jarvis-badge' }, 'Learning');
  const exportButton = node('button', { type: 'button', id: 'jarvis-export', title: 'Download this chat as Markdown' }, 'Export');
  const status = node('p', { className: 'muted jarvis-status', role: 'status' });

  const newChat = node('button', { type: 'button', className: 'primary', id: 'jarvis-new', onclick: () => openThread(null) }, '+ New chat');
  const search = node('input', { type: 'search', id: 'jarvis-search', placeholder: 'Search chats', maxLength: 80, ariaLabel: 'Search chats' });
  const threadList = node('ul', { className: 'jarvis-threads-list' });
  const sidebar = node('aside', { className: 'jarvis-threads' }, newChat, search, threadList);

  const log = node('div', { className: 'jarvis-log', ariaLive: 'polite' });
  const chips = node('div', { className: 'jarvis-chips' });
  const prompt = node('textarea', { id: 'jarvis-prompt', required: true, maxLength: 12000, rows: 2, ariaLabel: 'Message Jose' });
  const send = node('button', { type: 'submit', className: 'primary', id: 'jarvis-send' }, 'Send');
  const composer = node('form', { className: 'jarvis-composer' }, prompt, send);
  const chat = node('div', { className: 'jarvis-chat' }, log, chips, composer);
  const learning = node('details', { className: 'surface jarvis-learning', id: 'jarvis-learning' });
  const instructions = instructionsForm({ headers });
  const instructionsBox = node('details', { className: 'surface jarvis-learning', id: 'jarvis-instructions', ontoggle: () => { if (instructionsBox.open) instructions.load(); } },
    node('summary', {}, 'Custom instructions'), instructions);
  const activity = node('ol', { className: 'jarvis-activity', ariaLabel: 'Recent processing' });
  const activityState = node('span', { className: 'pill', role: 'status' }, 'Idle');
  const activityPanel = node('aside', { className: 'jarvis-activity-panel' },
    node('div', { className: 'jarvis-activity-header' }, node('h2', {}, 'Processing log'), activityState), activity);
  const topicPanel = node('section', { className: 'jarvis-topics', ariaLabel: 'Chat topics' });
  const topicMap = mountTopics(topicPanel, id => {
    void openThread(id);
    prompt.focus();
  }, renderThreadRow, () => call('/api/jarvis-diagnostics'));
  const panel = node('div', { className: 'jarvis' },
    node('div', { className: 'jarvis-head' }, node('h1', {}, 'Jose'), roleSelect, badge, exportButton),
    node('div', { className: 'jarvis-topics-layout' }, topicPanel, activityPanel), node('div', { className: 'jarvis-layout' }, sidebar, chat), status, estimatingBooking(call), instructionsBox, learning);

  function renderRoles() {
    roleSelect.replaceChildren(...Object.entries(builtins).map(([id, label]) => new Option(label, id)),
      ...bots.map(bot => new Option('Bot: ' + bot.name, bot.id)), new Option('+ New bot...', '__new'));
    roleSelect.value = role;
  }
  roleSelect.onchange = () => {
    if (roleSelect.value === '__new') { roleSelect.value = role; learning.open = true; renderLearning(true); return; }
    role = roleSelect.value;
    threadId = null; messages = []; query = ''; search.value = ''; topicMap.close(false);
    renderLog();
    refresh(true);
  };
  prompt.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
  };
  let searchTimer;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      query = search.value.trim();
      if (query.length < 2) { query = ''; renderThreads(); return; }
      try {
        const { results } = await call('/api/jarvis-memory?role=' + encodeURIComponent(role) + '&q=' + encodeURIComponent(query));
        renderThreads(results);
      } catch (error) { status.textContent = error.message; }
    }, 300);
  };
  exportButton.onclick = () => {
    if (!messages.length) { status.textContent = 'Nothing to export yet.'; return; }
    const title = threads.find(t => t.id === threadId)?.title || 'Jose chat';
    const lines = ['# ' + title, '', 'Agent: ' + nameOf(role) + '  ', 'Exported: ' + new Date().toLocaleString(), ''];
    for (const message of messages) {
      lines.push('## ' + (message.role === 'user' ? 'You' : 'Jose' + (message.meta?.trace ? ' (' + message.meta.trace.map(id => traceNames[id] || nameOf(id)).join(' > ') + ')' : '')), '');
      if (message.meta?.buildSummary) lines.push(message.meta.buildSummary, '');
      lines.push(message.content || '', '');
      if (message.meta?.plan) lines.push('```json', JSON.stringify(message.meta.plan, null, 2), '```', '');
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    const link = node('a', { href: url, download: title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) + '.md' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Chat exported as Markdown.';
  };

  function setBusy(value) {
    busy = value;
    topicMap.setBusy(value);
    activityState.textContent = value ? 'Analyzing' : 'Idle';
    for (const control of [roleSelect, prompt, send, newChat]) control.disabled = value;
  }

  function renderBadge() {
    if (!learned) { badge.textContent = 'Learning'; return; }
    const { stats, playbook, lessons } = learned;
    const active = playbook.length + lessons.filter(item => !item.consolidated).length;
    badge.textContent = stats.runs + ' runs · ' + (stats.helpfulRate === null ? 'no ratings' : pct(stats.helpfulRate) + ' helpful') + ' · ' + active + ' rules';
    badge.title = 'Rate replies and add corrections. The agent rewrites its playbook every 5 ratings.';
  }

  function renderThreadRow(entry, open, searchResult = false) {
    const button = node('button', { type: 'button', className: 'jarvis-thread' + (entry.id === threadId ? ' active' : ''), onclick: open },
      node('span', {}, (entry.pinned ? '📌 ' : '') + entry.title), searchResult ? node('small', {}, entry.snippet || 'Title match') : node('small', {}, new Date(entry.updatedAt).toLocaleString()));
    const act = (label, title, handler) => node('button', { type: 'button', className: 'jarvis-icon', title, ariaLabel: title, onclick: handler }, label);
    return node('li', {}, button,
      act(entry.pinned ? '◉' : '○', entry.pinned ? 'Unpin chat' : 'Pin chat', () => threadAction({ action: 'pin', threadId: entry.id, pinned: !entry.pinned })),
      act('✎', 'Rename chat', () => {
        const title = window.prompt('Chat title', entry.title);
        if (title?.trim()) threadAction({ action: 'rename', threadId: entry.id, text: title.trim().slice(0, 60) });
      }),
      act('×', 'Delete chat', () => {
        if (!confirm('Delete this chat? Learned lessons stay.')) return;
        threadAction({ action: 'delete', threadId: entry.id }).then(() => { if (entry.id === threadId) { threadId = null; messages = []; renderLog(); } });
      }));
  }

  function renderThreads(results = null) {
    topicMap.update(threads);
    const list = results || [];
    threadList.replaceChildren(...list.map(entry => renderThreadRow(entry, () => openThread(entry.id), true)));
    if (results && !list.length) threadList.append(node('li', { className: 'jarvis-empty muted' }, 'No matching chats.'));
  }

  async function threadAction(body) {
    try { await memoryCall(body); await refresh(); } catch (error) { status.textContent = error.message; }
  }

  async function learn(body, done, target = role) {
    status.textContent = body.action === 'reflect' ? 'Reflecting on feedback...' : 'Saving...';
    try {
      const result = await memoryCall(body, target);
      if (result.memory && target === role) learned = result.memory;
      if (result.shared) shared = result.shared;
      if (result.bots) { bots = result.bots; renderRoles(); }
      status.textContent = done;
      renderBadge();
      renderLearning();
      return result;
    } catch (error) {
      status.textContent = error.message;
      return null;
    }
  }

  function form(placeholder, max, label, submit, id) {
    const input = node('input', { maxLength: max, placeholder, ...(id ? { id } : {}) });
    return node('form', { className: 'jarvis-composer', onsubmit: event => { event.preventDefault(); if (input.value.trim()) submit(input.value.trim()); } },
      input, node('button', { type: 'submit' }, label));
  }

  function botForm(bot = null) {
    const name = node('input', { maxLength: 40, required: true, placeholder: 'Bot name, e.g. Bid Coach', value: bot?.name || '', id: 'jarvis-bot-name' });
    const description = node('input', { maxLength: 200, placeholder: 'What it is for (the main bot uses this to delegate)', value: bot?.description || '' });
    const instructions = node('textarea', { maxLength: 1500, required: true, rows: 3, placeholder: 'Instructions for this bot', value: bot?.instructions || '', id: 'jarvis-bot-instructions' });
    const context = node('select', {}, new Option('No data', 'none'), new Option('A2Z metrics', 'metrics'), new Option('Mailbox snapshot', 'mail'));
    context.value = bot?.context || 'none';
    return node('form', { className: 'jarvis-bot-form', onsubmit: async event => {
      event.preventDefault();
      const body = { bot: { name: name.value.trim(), description: description.value.trim(), instructions: instructions.value.trim(), context: context.value } };
      const result = bot ? await learn({ action: 'bot-update', ...body }, 'Bot updated.', bot.id) : await learn({ action: 'bot-create', ...body }, 'Bot created.', 'main');
      if (result?.bot && !bot) { role = result.bot.id; renderRoles(); roleSelect.onchange(); }
    } }, name, description, instructions, node('label', { className: 'field' }, node('span', {}, 'Data source'), context),
    node('div', { className: 'actions' }, node('button', { type: 'submit', className: 'primary' }, bot ? 'Save bot' : 'Create bot'),
      bot ? node('button', { type: 'button', onclick: async () => {
        if (!confirm('Delete ' + bot.name + ' with its chats and memory?')) return;
        if (await learn({ action: 'bot-delete' }, 'Bot deleted.', bot.id)) { role = 'main'; renderRoles(); roleSelect.onchange(); }
      } }, 'Delete bot') : null));
  }

  function renderLearning(newBot = false) {
    const open = learning.open;
    learning.replaceChildren(node('summary', {}, 'What ' + nameOf(role) + ' has learned'));
    if (!learned) { learning.append(node('p', { className: 'muted' }, 'Memory is unavailable. Replies still work but are not saved.')); learning.open = open; return; }
    const { stats, playbook, playbookVersion: pv, versions, rollbacks, lessons, qcFindings } = learned;
    learning.append(node('p', { className: 'muted', id: 'jarvis-stats' },
      stats.runs + ' runs · ' + stats.up + ' helpful · ' + stats.down + ' needs work · ' + stats.exemplars + ' approved examples · ' + stats.reflections + ' reflections' +
      (stats.qcPass + stats.qcFail ? ' · QC pass ' + pct(stats.qcPass / (stats.qcPass + stats.qcFail)) : '') +
      (stats.lastReflectAt ? ' · last reflection ' + new Date(stats.lastReflectAt).toLocaleString() : '')));
    learning.append(node('h3', {}, 'Playbook v' + pv.version + ' · ' + pv.ratings + ' ratings · ' + pct(pv.helpfulRate) + ' helpful' + (pv.restored ? ' · restored' : '')),
      playbook.length ? node('ol', { id: 'jarvis-playbook' }, ...playbook.map(rule => node('li', {}, rule)))
        : node('p', { className: 'muted' }, 'No playbook yet. Rate replies, then select Reflect now or wait for automatic reflection.'));
    if (versions.length) learning.append(node('h3', {}, 'Earlier versions'), node('ul', {}, ...versions.map(v => node('li', {},
      'v' + v.version + ' · ' + v.rules + ' rules · ' + v.ratings + ' ratings · ' + pct(v.helpfulRate) + ' helpful ',
      node('button', { type: 'button', onclick: () => { if (confirm('Restore playbook v' + v.version + '?')) learn({ action: 'playbook-restore', version: v.version }, 'Playbook v' + v.version + ' restored.'); } }, 'Restore')))));
    if (rollbacks.length) learning.append(node('h3', {}, 'Rollback log'), node('ul', {}, ...rollbacks.slice(0, 5).map(r => node('li', { className: 'muted' },
      new Date(r.at).toLocaleString() + ': v' + r.from + ' (' + pct(r.fromRate) + ') to v' + r.to + ' (' + pct(r.toRate) + ')' + (r.manual ? ', manual' : ', automatic')))));
    const active = lessons.filter(item => !item.consolidated || item.source === 'manual');
    learning.append(node('h3', {}, 'Instructions and corrections'), active.length
      ? node('ul', { className: 'jarvis-lessons' }, ...active.map(item => node('li', {},
        node('span', { className: 'jarvis-tag' }, sourceLabels[item.source] || item.source), ' ' + item.text + ' ',
        node('button', { type: 'button', className: 'jarvis-icon', title: 'Forget', ariaLabel: 'Forget lesson', onclick: () => learn({ action: 'lesson-delete', id: item.id }, 'Lesson removed.') }, '×'))))
      : node('p', { className: 'muted' }, 'None. Type "remember: ..." in chat or add one below.'));
    if (role === 'build' && qcFindings.length) learning.append(node('h3', {}, 'Recent QC rejections it avoids'), node('ul', {}, ...qcFindings.slice(0, 3).map(item => node('li', {}, item.text))));
    learning.append(form('Add a standing instruction for this agent', 300, 'Add', text => learn({ action: 'lesson-add', text }, 'Instruction saved.'), 'jarvis-lesson'),
      node('div', { className: 'actions' },
        node('button', { type: 'button', id: 'jarvis-reflect', onclick: () => learn({ action: 'reflect' }, 'Playbook rewritten from feedback.') }, 'Reflect now'),
        node('button', { type: 'button', onclick: () => { if (confirm('Erase everything this agent has learned? Chats stay.')) learn({ action: 'reset' }, 'Memory reset.'); } }, 'Reset memory')));
    learning.append(node('h3', {}, 'Company memory (all agents) · ' + shared.length + ' of 20'),
      shared.length ? node('ul', { className: 'jarvis-lessons', id: 'jarvis-shared' }, ...shared.map(item => node('li', {}, item.text + ' ',
        node('button', { type: 'button', className: 'jarvis-icon', title: 'Delete', ariaLabel: 'Delete company fact', onclick: () => learn({ action: 'shared-delete', id: item.id }, 'Company fact removed.') }, '×'))))
        : node('p', { className: 'muted' }, 'Add labor rates, crew sizes or scope terms. Or type "remember for all agents: ..." in chat.'),
      form('Company fact or rule for every agent', 300, 'Add', text => learn({ action: 'shared-add', text }, 'Saved to company memory.'), 'jarvis-shared-input'));
    const bot = bots.find(item => item.id === role);
    learning.append(node('h3', {}, bot ? 'Edit ' + bot.name : 'Create a bot'), botForm(bot && !newBot ? bot : null));
    learning.open = open || newBot;
  }

  function planView(meta) {
    const box = node('div', { className: 'jarvis-plan' });
    if (meta.validation && !meta.validation.ok) return null;
    if (!meta.plan) return null;
    box.append(node('p', { className: 'jarvis-heading' }, 'Plan: ' + meta.plan.task),
      node('ol', {}, ...meta.plan.steps.map(step => node('li', {}, step.action + (step.sql ? ': ' + step.sql : step.module ? ': ' + step.module + (step.source ? ' from ' + step.source + '.' + step.fieldName : '') : step.schedule ? ': ' + step.schedule : '')))));
    if (meta.warnings?.length || meta.validation?.warnings?.length) box.append(node('ul', { className: 'muted' }, ...(meta.validation?.warnings || meta.warnings).map(w => node('li', {}, w))));
    if (!meta.planHash) return box;
    const output = node('div', { className: 'jarvis-run' });
    const runButton = node('button', { type: 'button', className: 'primary jarvis-run-button', onclick: async () => {
      if (!confirm('Run this plan in the sandbox? It uses a throwaway copy of A2Z data. Nothing is applied to production.')) return;
      runButton.disabled = true;
      output.replaceChildren(node('p', { className: 'muted' }, 'Running in the sandbox...'));
      try {
        const result = await call('/api/jarvis-execute', { method: 'POST', body: { action: 'run', plan: meta.plan, planHash: meta.planHash, preset: preset() } });
        output.replaceChildren(node('p', { className: 'jarvis-heading' }, 'Sandbox ' + result.outcome + '. Applied to production: no.'),
          ...(result.error ? [node('p', {}, result.error)] : []),
          ...result.steps.map(step => node('div', {}, node('p', {}, (step.ok ? '✓ ' : '✗ ') + step.action + ': ' + step.detail), table(step.rows))),
          ...result.checks.map(check => node('div', {}, node('p', {}, (check.ok ? '✓ ' : '✗ ') + 'Check ' + check.check + ': ' + check.detail), table(check.rows))));
      } catch (error) {
        output.replaceChildren(node('p', {}, error.message));
      } finally {
        runButton.disabled = false;
      }
    } }, 'Run in sandbox');
    box.append(runButton, output);
    return box;
  }

  function feedbackBar(message) {
    if (!message.id || !threadId || !message.meta?.trace || message.meta.execute) return null;
    const bar = node('div', { className: 'jarvis-feedback' });
    const draw = () => {
      bar.replaceChildren();
      const rate = async (rating, note) => {
        try {
          const result = await memoryCall({ action: 'feedback', threadId, messageId: message.id, rating, ...(note ? { note } : {}) });
          message.rating = rating;
          if (note) message.note = note;
          learned = result.memory;
          renderBadge();
          renderLearning();
          const who = result.learner && result.learner !== role ? ' (' + nameOf(result.learner) + ' learns from it)' : '';
          status.textContent = result.rolledBack ? 'Feedback saved. The new playbook rated worse, so the previous version was restored.'
            : result.reflection === 'updated' ? 'Feedback saved. The agent rewrote its playbook' + who + '.' : 'Feedback saved' + who + '.';
          draw();
        } catch (error) {
          status.textContent = error.message;
        }
      };
      const good = node('button', { type: 'button', className: 'jarvis-rate' + (message.rating === 1 ? ' on' : ''), onclick: () => rate(1) }, '▲ Helpful');
      const bad = node('button', { type: 'button', className: 'jarvis-rate' + (message.rating === -1 ? ' on' : ''), onclick: () => {
        const note = node('input', { maxLength: 300, placeholder: 'What should it do differently? (optional)', className: 'jarvis-correction' });
        bar.replaceChildren(node('form', { className: 'jarvis-composer', onsubmit: event => { event.preventDefault(); rate(-1, note.value.trim()); } },
          note, node('button', { type: 'submit' }, 'Teach')));
        note.focus();
      } }, '▼ Needs work');
      bar.append(good, bad);
      if (message.note) bar.append(node('small', { className: 'muted' }, 'Correction: ' + message.note));
    };
    draw();
    return bar;
  }

  function bubble(message) {
    if (message.role === 'user') return node('div', { className: 'jarvis-msg user' }, formatted(message.content.startsWith('/execute') ? '/execute (plan JSON, ' + message.content.length + ' characters)' : message.content));
    const meta = message.meta || {};
    const box = node('div', { className: 'jarvis-msg assistant' + (message.error ? ' error' : '') });
    const tags = [(meta.trace || []).map(id => traceNames[id] || nameOf(id)).join(' > '), typeof meta.approved === 'boolean' && meta.trace?.includes('qc') ? (meta.approved ? 'QC passed' : 'Changes needed') : null,
      meta.usage ? meta.usage.totalTokens + ' tokens' : null].filter(Boolean);
    if (tags.length) box.append(node('div', { className: 'jarvis-trace' }, tags.join(' · ')));
    if (meta.buildSummary) box.append(formatted(meta.buildSummary));
    box.append(formatted(message.content));
    box.append(...[planView(meta), feedbackBar(message)].filter(Boolean));
    return box;
  }

  function renderLog(thinking = false) {
    log.replaceChildren(node('div', { className: 'jarvis-msg assistant intro' }, greetings[role] || 'Custom bot online. ' + (bots.find(b => b.id === role)?.description || '')), ...messages.slice(-200).map(bubble));
    if (thinking) log.append(node('div', { className: 'jarvis-msg assistant thinking' }, node('span'), node('span'), node('span')));
    chips.replaceChildren(...(messages.length ? [] : (suggestions[role] || []).map(text =>
      node('button', { type: 'button', className: 'jarvis-chip', onclick: () => { prompt.value = text; prompt.focus(); } }, text))));
    prompt.placeholder = messages.length ? 'Follow up. "remember:" teaches this agent, "remember for all agents:" teaches every agent.' : 'Message Jose, or paste /execute {plan JSON}';
    log.scrollTop = log.scrollHeight;
    const events = messages.filter(message => message.meta?.trace || message.error).slice(-200);
    activity.replaceChildren(...events.map(message => node('li', {},
      message.error ? 'Processing failed' : message.meta.trace.map(id => traceNames[id] || nameOf(id)).join(' > '))));
    if (thinking) activity.append(node('li', {}, 'Processing chat request'));
    activity.scrollTop = activity.scrollHeight;
  }

  async function refresh(openLatest = false) {
    const token = ++loadToken;
    try {
      const data = await call('/api/jarvis-memory?role=' + encodeURIComponent(role));
      if (token !== loadToken) return;
      ({ threads, shared, bots } = data);
      learned = data.memory;
      renderRoles();
      renderThreads();
      renderBadge();
      renderLearning();
      if (openLatest && threads[0] && !threadId) await openThread(threads[0].id);
    } catch (error) {
      if (token !== loadToken) return;
      learned = null;
      renderBadge();
      renderLearning();
      status.textContent = error.status === 503 ? 'Chat history is unavailable. Replies still work but are not saved.' : error.message;
    }
  }

  async function openThread(id) {
    if (busy) return;
    threadId = id;
    messages = [];
    status.textContent = '';
    renderThreads();
    if (!id) { renderLog(); prompt.focus(); return; }
    const token = ++loadToken;
    try {
      const { thread } = await call('/api/jarvis-memory?role=' + encodeURIComponent(role) + '&thread=' + encodeURIComponent(id));
      if (token !== loadToken) return;
      messages = thread.messages;
      const entry = threads.find(item => item.id === thread.id);
      if (entry && thread.topic && entry.topic !== thread.topic) {
        topicMap.classified(thread.id);
        entry.topic = thread.topic;
        renderThreads();
      }
      renderLog();
    } catch (error) {
      status.textContent = error.message;
      threadId = null;
      renderLog();
    }
  }

  composer.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const task = prompt.value.trim();
    if (!task) return;
    if (task.length > 1000 && !task.startsWith('/execute')) { status.textContent = 'Keep messages under 1000 characters.'; return; }
    const requestedRole = role;
    prompt.value = '';
    status.textContent = '';
    messages.push({ role: 'user', content: task });
    setBusy(true);
    renderLog(true);
    try {
      const command = { role: requestedRole, prompt: task, preset: preset() };
      if (threadId) command.threadId = threadId;
      else command.newThread = true;
      let result;
      try {
        result = await call('/api/jarvis', { method: 'POST', body: command });
      } catch (error) {
        if (error.status !== 404 || !command.threadId) throw error;
        delete command.threadId;
        command.newThread = true;
        result = await call('/api/jarvis', { method: 'POST', body: command });
      }
      if (role !== requestedRole) return;
      const meta = {};
      for (const name of ['trace', 'approved', 'buildSummary', 'agent', 'plan', 'planHash', 'warnings', 'validation', 'usage', 'execute']) if (result[name] !== undefined) meta[name] = result[name];
      messages.push({ id: result.messageId, role: 'assistant', content: result.answer, meta });
      if (result.threadId) {
        if (command.newThread) topicMap.classified(result.threadId);
        threadId = result.threadId;
      }
      if (result.memoryError) status.textContent = result.memoryError;
      refresh();
    } catch (error) {
      if (role !== requestedRole) return;
      messages.push({ role: 'assistant', content: error.message, error: true });
      prompt.value ||= task;
    } finally {
      setBusy(false);
      if (role === requestedRole) renderLog();
    }
  };

  panel.load = () => { if (!learned && !busy) refresh(true); };
  renderRoles();
  renderLog();
  renderThreads();
  renderLearning();
  return panel;
}
