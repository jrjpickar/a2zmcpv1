// Builds one self-contained HTML preview on sample data: node scripts/build-sandbox.mjs dist/sandbox.html
// Run npm run build:city first so public/city3d.js is current.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { diagnostics, report } from '../netlify/functions/lib/report.mjs';
import { mailSample } from '../netlify/functions/lib/mail.mjs';
import { catalog, defaults } from '../netlify/functions/lib/alerts.mjs';

const out = process.argv[2] || 'dist/sandbox.html';
const read = f => readFile(new URL('../public/' + f, import.meta.url), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const reports = {};
for (const preset of ['today', 'wtd', 'mtd', '30d', 'ytd']) reports[preset] = await report({ preset }, { DATA_MODE: 'sample' });
const metrics = catalog(reports.mtd).map(({ format, ...m }) => ({ ...m, valueText: m.kind === 'status' ? m.value : format(m.value) }));
const alerts = { settings: defaults(), alerts: [], metrics, canEdit: true };
const health = await diagnostics({ env: { DATA_MODE: 'sample', GROQ_API_KEY: 'x', DASHBOARD_KEY: 'x' } });
health.checks.push({ id: 'blobs', group: 'Services', label: 'Netlify Blobs (alert settings)', status: 'ok', detail: 'Settings store reachable', ms: 41, checkedAt: health.generatedAt },
  { id: 'alerts', group: 'Services', label: 'Alert scheduler (every 15 min)', status: 'setup', detail: 'No alert rules enabled', ms: null, checkedAt: null, records: { rulesEnabled: 0, webhook: 'hook.us2.make.com', cooldownMinutes: 240 } });
const [html, css, city, map, app, instructions, voiceJs, voiceCss] = await Promise.all(['index.html', 'styles.css', 'city3d.js', 'map.js', 'app.js', 'instructions.mjs', 'voice.js', 'voice.css'].map(read));
const stub = `const SAMPLE = ${JSON.stringify(reports)};
try { sessionStorage.getItem('x'); } catch { Object.defineProperty(window, 'sessionStorage', { value: { getItem() { return ''; }, setItem() {}, removeItem() {} } }); }
const ALERTS = ${JSON.stringify(alerts)};
const HEALTH = ${JSON.stringify(health)};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function evaluateRules() {
  ALERTS.alerts = Object.entries(ALERTS.settings.rules).filter(([, r]) => r.enabled).flatMap(([id, r]) => {
    const m = ALERTS.metrics.find(x => x.key === id);
    const hit = m && (r.op === 'not_ok' ? m.kind === 'status' && !m.ok : m.value != null && (r.op === 'below' ? m.value < r.threshold : m.value > r.threshold));
    return hit ? [{ id, metric: m.label, district: m.district, message: m.label + (r.op === 'not_ok' ? ' is not healthy' : ' ' + r.op + ' ' + r.threshold) + ': now ' + m.valueText }] : [];
  });
}
// Sandbox only: every 9 seconds the sample data changes the way live data would (a proposal goes out, a worker is booked,
// a job is won, a worker is released), then the page refreshes, so the same code paths that run live drive the cars and walkers.
const demo = [
  r => { r.kpis.funnel.proposals++; },
  r => { const w = r.kpis.workforce, p = w.bench.shift(); if (p) { w.crew.push({ ...p, job: w.crew[0]?.job || 'New job' }); w.workers++; w.booked++; w.available--; } },
  r => { r.kpis.funnel.wins++; },
  r => { const w = r.kpis.workforce, p = w.crew.pop(); if (p) { const { job, ...rest } = p; w.bench.push(rest); w.workers--; w.booked--; w.available++; } },
];
let step = 0;
let unread = 6;
setInterval(() => {
  const change = demo[step++ % demo.length];
  Object.values(SAMPLE).forEach(change);
  document.getElementById('refresh')?.click();
}, 9000);
const sandboxRequest = async (url, init = {}) => {
  await new Promise(r => setTimeout(r, 250));
  const u = new URL(url, 'https://sandbox.invalid');
  if (u.pathname === '/api/mail-summary') return reply(${JSON.stringify(mailSample)});
  if (u.pathname === '/api/mail') return reply({
    status: 'ok',
    asOf: new Date().toISOString(),
    stats: { unreadIncoming: unread++, bidInvitations: 2, urgentUnread: 1, awaitingReply: 5, unreadInvoiceMail: 2 },
  });
  if (u.pathname === '/api/diagnostics') return reply({ ...HEALTH, generatedAt: new Date().toISOString(), fresh: u.searchParams.get('fresh') === '1' });
  if (u.pathname === '/api/ask') return reply({ error: 'Sandbox preview: Groq runs on the deployed site with GROQ_API_KEY. The signals above are live from the sample data.' }, 503);
  if (u.pathname === '/api/alerts') {
    const method = init.method || 'GET';
    if (method === 'PUT') { ALERTS.settings = JSON.parse(init.body); evaluateRules(); return reply({ settings: ALERTS.settings }); }
    if (method === 'POST') return reply({ error: 'Sandbox preview: nothing was sent. The deployed site posts to the webhook.' }, 503);
    return reply(ALERTS);
  }
  return reply({ ...(SAMPLE[u.searchParams.get('preset')] || SAMPLE.mtd), alerts: ALERTS.alerts });
};`;
const page = html.replace('<!doctype html>', '<!DOCTYPE html>')
  .replace('<title>A2Z Operations</title>', '<title>A2Z Operations Sandbox</title>')
  .replace('<link rel="stylesheet" href="/styles.css">', () => '<style>' + css + '</style>')
  .replace('<link rel="stylesheet" href="/voice.css">', () => '<style>' + voiceCss + '</style>')
  .replace('<script src="/city3d.js"></script>', () => '<script>' + safe(city) + '</script>')
  .replace('<p id="status"', '<button type="button" id="demo-mail">Simulate delivery</button><p id="status"')
  .replace('<script type="module" src="/app.js"></script>', '')
  .replace('</body>', () => '<script type="module">' + safe(stub + '\n' + map.replace(/^export /gm, '') + '\n' + voiceJs.replace(/^export /gm, '').replace(/\bfetch\(/g, 'sandboxRequest(') + '\n' + instructions.replace(/^export /gm, '').replace(/\bfetch\(/g, 'sandboxRequest(') + '\n' + app.replace(/^import .*\n/gm, '').replace(/\bfetch\(/g, 'sandboxRequest(')
      .replace('refresh().then(route);', "refresh().then(() => { route(); select('mail'); });")
      + "\ndocument.getElementById('demo-mail').addEventListener('click', () => { select('mail'); updateMail(); });" ) + '</script>\n</body>');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log('Wrote ' + out + ' (' + Math.round(page.length / 1024) + ' KB)');
