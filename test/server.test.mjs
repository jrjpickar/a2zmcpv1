import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const token = 'server-test-token-0123456789';
async function start(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'a2z-server-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.mjs'], {
    env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', DATA_MODE: 'sample', SCHEDULER: 'off', MCP_AUTH_TOKEN: token, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  for (let i = 0; i < 50 && !/A2Z MCP server on port/.test(output); i++) {
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return { base: 'http://127.0.0.1:' + port, child, exited, output: () => output, stop: () => { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); } };
}
const rpc = (base, body, headers = {}, path = '/mcp') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

test('server refuses to start without a 16+ character MCP_AUTH_TOKEN', async () => {
  const server = await start({ MCP_AUTH_TOKEN: 'short' });
  assert.equal(await server.exited, 1);
  assert.match(server.output(), /MCP_AUTH_TOKEN/);
  server.stop();
});

test('server: /health, bearer auth on /mcp, Streamable HTTP JSON responses, no token in logs', async t => {
  const server = await start();
  t.after(server.stop);
  const health = await fetch(server.base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await rpc(server.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await rpc(server.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer wrong-token-0123456789' })).status, 401);
  const auth = { authorization: 'Bearer ' + token };
  const init = await (await rpc(server.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, auth)).json();
  assert.equal(init.result.serverInfo.name, 'a2z-mcp');
  assert.equal((await rpc(server.base, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
  const list = await (await rpc(server.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).json();
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['a2z_operating_report']);
  assert.equal((await rpc(server.base, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, {}, '/mcp/' + token)).status, 401, 'URL token is off by default');
  assert.equal((await fetch(server.base + '/')).status, 401);
  assert.ok(!server.output().includes(token));
});

test('server: optional URL token form when MCP_URL_TOKEN=on', async t => {
  const server = await start({ MCP_URL_TOKEN: 'on' });
  t.after(server.stop);
  const list = await rpc(server.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, '/mcp/' + token);
  assert.equal(list.status, 200);
  assert.equal((await rpc(server.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, '/mcp/wrong-token-0123456789')).status, 401);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!server.output().includes(token), 'token URLs are masked in logs');
  assert.match(server.output(), /\/mcp\/\*\*\*/);
});


test('dashboard login issues a secure session and protects the dashboard and API', async t => {
  const key = 'dashboard-test-key-0123456789';
  const server = await start({ DASHBOARD_KEY: key });
  t.after(server.stop);
  const proxy = { 'x-forwarded-proto': 'https' };
  const origin = server.base.replace('http:', 'https:');
  assert.equal((await fetch(server.base + '/api/metrics', { headers: proxy })).status, 401);
  const form = { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key }) };
  const crossSite = await fetch(server.base + '/login', {
    ...form, headers: { ...proxy, origin: 'null', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const response = await fetch(server.base + '/login', {
    ...form, headers: { ...proxy, origin: 'null', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!cookie.includes(key));
  const headers = { ...proxy, cookie: cookie.split(';')[0] };
  assert.equal((await fetch(server.base + '/', { headers })).status, 200);
  assert.equal((await fetch(server.base + '/api/metrics', { headers })).status, 200);
  assert.equal((await fetch(server.base + '/api/alerts', { method: 'POST', headers: { ...headers, origin: 'https://different.example' } })).status, 403);
});

test('mail WebSocket requires a same-origin dashboard session and delivers a snapshot', async t => {
  const { WebSocket } = await import('ws');
  const key = 'dashboard-test-key-0123456789';
  const server = await start({ DASHBOARD_KEY: key });
  t.after(server.stop);
  const origin = server.base.replace('http:', 'https:');
  const url = server.base.replace('http:', 'ws:') + '/live';
  const headers = { 'x-forwarded-proto': 'https', origin };
  const anonymous = new WebSocket(url, { headers });
  await new Promise((resolve, reject) => {
    anonymous.once('error', error => {
      try { assert.match(error.message, /401/); resolve(); } catch (failure) { reject(failure); }
    });
    anonymous.once('open', () => { anonymous.close(); reject(new Error('Anonymous socket accepted')); });
  });
  const login = await fetch(server.base + '/login', {
    method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ key }),
  });
  const socket = new WebSocket(url, { headers: { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] } });
  t.after(() => socket.terminate());
  const event = await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', data => resolve(JSON.parse(data)));
  });
  assert.equal(event.type, 'mail');
  assert.equal(event.mail.stats.unreadIncoming, 6);
});

test('VM voice starts with a rotating HTTPS tunnel origin and accepts audio-sized requests', async t => {
  const { request } = await import('node:http');
  const key = 'dashboard-test-key-0123456789';
  const server = await start({
    DASHBOARD_KEY: key, VOICE_ENABLED: '1', GROQ_API_KEY: 'test-only',
    VOICE_APPROVED_REASONING: 'groq', VOICE_GROQ_STT_APPROVED: '1',
  });
  t.after(server.stop);
  const host = 'sample-rotating-host.trycloudflare.com';
  async function post(path, data, headers = {}) {
    const body = JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const req = request(server.base + path, { method: 'POST', headers: {
        host, origin: 'https://' + host, 'x-forwarded-proto': 'https',
        'x-a2z-key': key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers,
      } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const session = await post('/api/voice', { action: 'start' });
  assert.equal(session.status, 200);
  assert.deepEqual(session.body.stt, ['groq']);
  const result = await post('/api/ask', {
    action: 'turn', id: '105834cc-213b-49a3-ae8a-b071cb7b7728', history: [],
    audio: 'A'.repeat(100000),
  }, { 'x-a2z-voice': session.body.token });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /PCM audio/);
});

test('server serves every module the dashboard imports', async t => {
  const { readdir, readFile } = await import('node:fs/promises');
  const key = 'dashboard-key-0123456789abcdef';
  const server = await start({ DASHBOARD_KEY: key });
  t.after(() => server.stop());
  const names = new Set();
  for (const file of (await readdir('public')).filter(name => /\.m?js$/.test(name) && name !== 'city3d.js')) {
    for (const match of (await readFile('public/' + file, 'utf8')).matchAll(/from '\.\/([\w.-]+)'/g)) names.add(match[1]);
  }
  assert.ok(names.has('estimating-booking.mjs'));
  for (const name of names) assert.equal((await fetch(server.base + '/' + name, { headers: { 'x-a2z-key': key } })).status, 200, name);
  assert.equal((await fetch(server.base + '/../package.json', { headers: { 'x-a2z-key': key } })).status, 404);
});
