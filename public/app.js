import { setupMap } from './map.js';

const $ = id => document.getElementById(id);
const number = value => value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const money = (value, currency = 'USD') => value == null ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
let key = sessionStorage.getItem('a2z-key') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('key')) {
  key = fragment.get('key');
  sessionStorage.setItem('a2z-key', key);
  history.replaceState(null, '', location.pathname + location.search);
}
let report;
let selected = 'system';
let pending;
const map = setupMap($('city'), $('stations'), select);

function tiles() {
  const { kpis, system } = report;
  const ready = Object.values(system.deploys).filter(d => d.state === 'ready').length;
  const checked = Object.values(system.deploys).filter(d => d.status === 'ok').length;
  return [
    { key: 'leads', title: 'New leads', short: 'Leads', value: number(kpis.funnel?.leads) },
    { key: 'proposals', title: 'Proposals sent', short: 'Proposals', value: number(kpis.funnel?.proposals) },
    { key: 'wins', title: 'Jobs won', short: 'Jobs won', value: number(kpis.funnel?.wins) },
    { key: 'labor', title: 'Labor sales', short: 'Labor', value: money(kpis.labor?.amount) },
    { key: 'containers', title: 'Container sales', short: 'Containers', value: money(kpis.containers?.amount) },
    { key: 'workforce', title: 'Active workforce', short: 'Workforce', value: number(kpis.workforce?.workers) },
    { key: 'runway', title: 'Financial runway', short: 'Runway', value: kpis.runway.months == null ? '—' : number(kpis.runway.months) + ' mo' },
    { key: 'system', title: 'System health', short: 'Systems', value: checked ? ready + ' / ' + Object.keys(system.deploys).length + ' live' : '—' },
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
    const row = node('div', undefined, 'row');
    row.append(node('dt', label), node('dd', value));
    if (detail) row.append(node('small', detail));
    list.append(row);
  }
  return list;
}

function details(tile) {
  $('detail-title').textContent = tile.title;
  const panel = $('detail-content');
  panel.replaceChildren();
  const { kpis, system } = report;
  if (tile.key === 'system') {
    const deployRows = Object.entries(system.deploys).map(([name, deploy]) => [
      name + ' deploy', deploy.state || (deploy.status === 'setup' ? 'Setup needed' : 'Unavailable'),
      deploy.detail || [
        deploy.publishedAt && 'Published ' + deploy.publishedAt.slice(0, 10),
        deploy.latestState && deploy.latestState !== deploy.state && 'Latest production build ' + deploy.latestState,
      ].filter(Boolean).join(' · '),
    ]);
    const sourceNames = { estimating: 'Estimating feed', dispatch: 'Dispatch feed', ledger: 'Ledger feed',
      ghl: 'GoHighLevel', twilio: 'Twilio API', make: 'Make API' };
    panel.append(rows([
      ['Twilio balance', money(system.twilio?.balance, system.twilio?.currency), system.twilio?.asOf && 'Checked ' + system.twilio.asOf.slice(0, 10)],
      ['Make credits remaining', number(system.make.balance), system.make.asOf ? system.make.basis + ' · ' + system.make.asOf : 'Billing snapshot or cycle inputs needed'],
      ['Make credits used', number(system.make.usage30d), 'API usage over the last 30 days'],
      ['Netlify credits remaining', number(system.netlify.balance), system.netlify.asOf ? system.netlify.basis + ' · ' + system.netlify.asOf : 'Billing snapshot needed'],
      ...deployRows,
      ['Pending Dispatch syncs', number(system.dispatch?.pendingSyncs)],
      ['Dispatch Make runs to review', number(system.dispatch?.makeRuns30d.bad), 'Dispatch effects awaiting confirmation or with errors in the past 30 days'],
      ...Object.entries(system.sources).map(([name, state]) => [sourceNames[name], state.status === 'ok' ? 'Connected' : state.status === 'setup' ? 'Setup needed' : 'Unavailable', state.detail]),
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
  } else if (tile.key === 'workforce') {
    panel.append(rows([['Active jobs with crew', number(kpis.workforce?.jobs)], ['Pacific date', kpis.workforce?.asOf || '—']]));
  } else if (tile.key === 'runway') {
    const r = kpis.runway;
    panel.append(rows([['Cash on hand', money(r.cash), r.asOf || 'Cash balance and date needed'],
      ['Monthly cash burn', money(r.monthlyBurn), r.basis]]));
  } else if (tile.key === 'labor' || tile.key === 'containers') {
    const sale = kpis[tile.key];
    panel.append(rows([['Sales counted', number(sale?.count)], ['Sales missing value', number(sale?.missingValue)],
      ...(tile.key === 'containers' ? [['Won sales missing date', number(sale?.missingDate)]] : [])]));
  }
}

const tileButtons = new Map();
function select(id, redraw = true) {
  selected = id;
  if (!report) return;
  const values = tiles();
  if (redraw) {
    for (const tile of values) {
      let button = tileButtons.get(tile.key);
      if (!button) {
        button = node('button', undefined, 'tile');
        button.type = 'button';
        button.addEventListener('click', () => select(tile.key));
        $('tiles').append(button);
        tileButtons.set(tile.key, button);
      }
      button.setAttribute('aria-pressed', String(tile.key === selected));
      button.replaceChildren(node('span', tile.title), node('strong', tile.value));
    }
    map.update(values, selected);
  }
  details(values.find(tile => tile.key === selected));
}

async function refresh() {
  pending?.abort();
  const current = new AbortController();
  pending = current;
  $('refresh').disabled = true;
  $('status').textContent = 'Refreshing…';
  try {
    const response = await fetch('/api/metrics?preset=' + encodeURIComponent($('range').value), {
      headers: { 'x-a2z-key': key }, signal: current.signal,
    });
    if (current.signal.aborted) return;
    if (response.status === 401) {
      report = null;
      key = '';
      sessionStorage.removeItem('a2z-key');
      $('key').value = '';
      $('dashboard').hidden = true;
      $('auth').hidden = false;
      $('status').textContent = 'Access key required';
      return;
    }
    if (!response.ok) throw new Error('Report unavailable');
    const next = await response.json();
    if (current.signal.aborted) return;
    report = next;
    $('auth').hidden = true;
    $('dashboard').hidden = false;
    const { mode, range } = report;
    const dates = range.from === range.to ? range.from : range.from + ' to ' + range.to;
    $('status').textContent = (mode === 'sample' ? 'Sample data · ' : '') + dates + ' · Pacific';
    select(selected);
  } catch {
    if (!current.signal.aborted) $('status').textContent = report
      ? 'Refresh failed · showing ' + report.range.from + ' to ' + report.range.to : 'Report unavailable';
  } finally {
    if (pending === current) $('refresh').disabled = false;
  }
}
$('controls').addEventListener('submit', event => { event.preventDefault(); refresh(); });
$('range').addEventListener('change', refresh);
$('signin').addEventListener('submit', event => {
  event.preventDefault();
  key = $('key').value.trim();
  $('key').value = '';
  sessionStorage.setItem('a2z-key', key);
  refresh();
});
$('reset').addEventListener('click', map.reset);
refresh();
