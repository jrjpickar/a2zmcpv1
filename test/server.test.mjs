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
  assert.equal((await fetch(server.base + '/')).status, 200);
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
