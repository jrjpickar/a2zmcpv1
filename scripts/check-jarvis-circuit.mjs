// Run directly with Playwright supplied by the caller. No browser dependency in the application.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JARVIS_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  ...(process.env.JARVIS_CHROME ? { executablePath: process.env.JARVIS_CHROME } : {}),
});
const root = new URL('../public/', import.meta.url);
const origin = 'http://localhost:55218';
const html = `<!doctype html><link rel="stylesheet" href="/styles.css">
<main class="jarvis-topics" style="--jarvis-density:320"></main><script type="module">
import { mountTopics, frontHit } from '/jarvis-topics.mjs';
const host = document.querySelector('main');
const dates = ['2026-11-18T00:00:00Z','2026-11-19T00:00:00Z'];
const threads = dates.map((updatedAt, i) => ({ id: String(i), title: 'Chat ' + i, topic: 'Estimating', updatedAt }));
window.frontHit = frontHit;
window.map = mountTopics(host, id => { window.openedChat = id; }, (entry, open) => {
  const row = document.createElement('li'), button = document.createElement('button');
  button.textContent = entry.title; button.onclick = open; row.append(button); return row;
}, async () => ({ status: 'degraded', models: {}, primary: 'primary', backup: 'backup', active: { model: 'backup', provider: 'Groq' }, events: [], errors: [] }));
map.update(threads);
</script>`;

async function open(width) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.samples = [];
    window.requestAnimationFrame = cb => request(timestamp => {
      const time = performance.now();
      cb(timestamp);
      window.samples.push([timestamp, performance.now() - time]);
    });
  });
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const body = await readFile(fileURLToPath(new URL(path.slice(1), root)));
    return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'application/javascript', body });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.samples.length >= 5);
  return page;
}

try {
  const page = await open(1080);
  const area = page.locator('canvas');
  const menu = page.getByRole('region', { name: 'Topic chats' });
  const topic = page.getByRole('button', { name: 'Estimating 2' });
  const box = await area.boundingBox();
  const blank = { x: box.width * .08, y: 18 };
  const point = { x: box.width * .84, y: box.height * .42 };
  assert.equal(await menu.count(), 0);
  await area.click({ position: blank });
  assert.equal(await menu.count(), 0);
  await area.click({ position: point });
  await menu.waitFor();
  assert.deepEqual(await menu.locator('ul button').allTextContents(), ['Chat 1', 'Chat 0']);
  await area.click({ position: blank });
  assert.equal(await menu.count(), 0);
  assert.equal(await topic.evaluate(element => document.activeElement === element), true);
  await topic.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0);
  assert.equal(await topic.evaluate(element => document.activeElement === element), true);
  await topic.press('Enter');
  await menu.getByRole('button', { name: 'Chat 1' }).click();
  assert.equal(await page.evaluate(() => window.openedChat), '1');
  assert.equal(await menu.count(), 0);
  assert.equal(await page.evaluate(() => window.frontHit([{ label: 'back', x: 0, y: 0, hitRadius: 20 }, { label: 'front', x: 0, y: 0, hitRadius: 20 }], 1, 1).label), 'front');
  await page.getByRole('button', { name: 'System Diagnostics', exact: true }).press('Enter');
  await menu.getByText('Status: Backup active').waitFor();
  await menu.getByRole('button', { name: 'Refresh' }).click();
  await menu.getByRole('button', { name: 'Close' }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  const before = (await cdp.send('Performance.getMetrics')).metrics.find(item => item.name === 'JSHeapUsedSize').value;
  await page.evaluate(() => { window.samples.length = 0; });
  await page.waitForTimeout(3000);
  const stats = await page.evaluate(() => {
    const samples = window.samples.slice(0, -1);
    const times = samples.map(([, duration]) => duration).sort((a, b) => a - b);
    return { fps: Math.round((samples.length - 1) * 1000 / (samples.at(-1)[0] - samples[0][0])),
      medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)], maxMs: times.at(-1) };
  });
  const after = (await cdp.send('Performance.getMetrics')).metrics.find(item => item.name === 'JSHeapUsedSize').value;
  console.log('320-trace profile:', JSON.stringify({ ...stats, jsHeapDelta: after - before }));
  const mobile = await open(390);
  await page.close();
  await mobile.getByRole('button', { name: 'Estimating 2' }).press('Enter');
  const close = mobile.getByRole('button', { name: 'Close' });
  await close.waitFor();
  assert.ok((await close.boundingBox()).height >= 44);
  assert.equal(await mobile.locator('.jarvis-topic-menu').evaluate(node => getComputedStyle(node).bottom), '0px');
  await mobile.close();
  console.log('Passed desktop, mobile, keyboard, overlap, chat opening and diagnostics browser tests.');
} finally {
  await browser.close();
}
