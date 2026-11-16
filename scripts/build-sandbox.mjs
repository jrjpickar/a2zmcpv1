// Builds one self-contained HTML preview on sample data: node scripts/build-sandbox.mjs dist/sandbox.html
// Run npm run build:city first so public/city3d.js is current.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { report } from '../netlify/functions/lib/report.mjs';
import { catalog, defaults } from '../netlify/functions/lib/alerts.mjs';

const out = process.argv[2] || 'dist/sandbox.html';
const read = f => readFile(new URL('../public/' + f, import.meta.url), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const reports = {};
for (const preset of ['today', 'wtd', 'mtd', '30d', 'ytd']) reports[preset] = await report({ preset }, { DATA_MODE: 'sample' });
const metrics = catalog(reports.mtd).map(({ format, ...m }) => ({ ...m, valueText: m.kind === 'status' ? m.value : format(m.value) }));
const alerts = { settings: defaults(), alerts: [], metrics, canEdit: true };
const [html, css, city, map, app] = await Promise.all(['index.html', 'styles.css', 'city3d.js', 'map.js', 'app.js'].map(read));
const stub = `const SAMPLE = ${JSON.stringify(reports)};
try { sessionStorage.getItem('x'); } catch { Object.defineProperty(window, 'sessionStorage', { value: { getItem() { return ''; }, setItem() {}, removeItem() {} } }); }
const ALERTS = ${JSON.stringify(alerts)};
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
setInterval(() => {
  const change = demo[step++ % demo.length];
  Object.values(SAMPLE).forEach(change);
  document.getElementById('refresh')?.click();
}, 9000);
window.fetch = async (url, init = {}) => {
  await new Promise(r => setTimeout(r, 250));
  const u = new URL(url, location.href);
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
  .replace('<script src="/city3d.js"></script>', () => '<script>' + safe(city) + '</script>')
  .replace('<script type="module" src="/app.js"></script>', '')
  .replace('</body>', () => '<script type="module">' + safe(stub + '\n' + map.replace(/^export /gm, '') + '\n' + app.replace(/^import .*\n/m, '')) + '</script>\n</body>');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log('Wrote ' + out + ' (' + Math.round(page.length / 1024) + ' KB)');
