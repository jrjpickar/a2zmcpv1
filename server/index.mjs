// A2Z MCP server for Docker and VM deploys (for example a Google Cloud e2-micro with the port on localhost only).
// It runs the same function handlers as Netlify: dashboard, JARVIS and the MCP endpoint (Streamable HTTP, JSON responses).
// Netlify deploys do not use this file.
//
// Env: MCP_AUTH_TOKEN (required, 16+ characters) protects /mcp with "Authorization: Bearer <token>".
//      MCP_URL_TOKEN=on also accepts POST /mcp/<token> for clients that cannot send headers. Off by default.
//      SUPABASE_URL + SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) store JARVIS memory in Supabase, else DATA_DIR/jarvis on disk.
//      PORT (default 8080), HOST (default 0.0.0.0), DATA_DIR (default /data), SCHEDULER=off disables the 15 and 30 minute jobs.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const env = process.env;
const token = env.MCP_AUTH_TOKEN?.trim() || '';
if (token.length < 16) {
  console.error('MCP_AUTH_TOKEN is missing or shorter than 16 characters. Set it in .env. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
// The existing /mcp handler checks MCP_KEY. This server uses MCP_AUTH_TOKEN as that key so there is one MCP secret.
env.MCP_KEY = token;
if (!env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_KEY) env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_KEY;
const dataDir = env.DATA_DIR || '/data';
env.A2Z_STORE_DIR ||= join(dataDir, 'operations');

const { openJarvisStore } = await import('../netlify/functions/lib/jarvis-store.mjs');
const { localKeyedStore } = await import('../netlify/functions/lib/local-store.mjs');
const { createJarvisHandler } = await import('../netlify/functions/jarvis.mjs');
const { createJarvisMemoryHandler } = await import('../netlify/functions/jarvis-memory.mjs');
const { createExecuteHandler } = await import('../netlify/functions/jarvis-execute.mjs');
const { mailSettings, syncMailbox } = await import('../netlify/functions/lib/jarvis-mail.mjs');

const supabase = Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
const localJarvis = supabase ? null : localKeyedStore(join(dataDir, 'jarvis'));
const openStore = async () => (supabase ? openJarvisStore(env) : localJarvis);

// Every Netlify function with a path becomes a route. JARVIS handlers get the server's store.
const functionsDir = new URL('../netlify/functions/', import.meta.url);
const routes = {};
const scheduled = {};
for (const file of (await readdir(functionsDir)).filter(name => name.endsWith('.mjs')).sort()) {
  const mod = await import(new URL(file, functionsDir));
  if (mod.config?.path) routes[mod.config.path] = mod.default;
  if (mod.config?.schedule) scheduled[file] = mod.default;
}
routes['/api/jarvis'] = createJarvisHandler({ openStore });
routes['/api/jarvis-memory'] = createJarvisMemoryHandler({ openStore });
routes['/api/jarvis-execute'] = createExecuteHandler({ openStore });
const bodyLimits = { '/api/jarvis': 16384, '/api/jarvis-memory': 8192, '/api/jarvis-execute': 16384, '/mcp': 16384 };

// Same response headers as netlify.toml.
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'self' https://app.gohighlevel.com https://app.leadconnectorhq.com",
};
const types = { html: 'text/html; charset=utf-8', js: 'application/javascript', mjs: 'application/javascript', css: 'text/css' };
const staticFiles = new Set(['index.html', 'app.js', 'map.js', 'city3d.js', 'styles.css', 'jarvis.mjs']);
const started = Date.now();
const digest = value => createHash('sha256').update(value).digest();
const tokenMatches = value => timingSafeEqual(digest(value), digest(token));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function readRequestBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  // Only this host reaches the port (compose binds 127.0.0.1), so a forwarded scheme from a local proxy is trusted.
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const url = new URL(req.url, proto + '://' + (req.headers.host || 'localhost'));
  let path = url.pathname;
  const headers = { ...req.headers };

  if (path === '/health') {
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '', { Allow: 'GET, HEAD' });
    return send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({
      status: 'ok', service: 'a2z-mcp', uptimeSeconds: Math.round((Date.now() - started) / 1000),
      storage: supabase ? 'supabase' : 'local', time: new Date().toISOString(),
    }), { 'Content-Type': 'application/json' });
  }

  // Optional token-in-URL form for connectors that cannot send an Authorization header.
  const urlToken = /^\/mcp\/([A-Za-z0-9._~-]{16,200})$/.exec(path);
  if (urlToken) {
    if (env.MCP_URL_TOKEN !== 'on' || !tokenMatches(urlToken[1])) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    headers.authorization = 'Bearer ' + token;
    path = '/mcp';
  }

  const fn = routes[path];
  if (fn) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequestBody(req, bodyLimits[path] || 65536);
    if (body === null) return send(res, 413, JSON.stringify({ error: 'Request body exceeds the size limit.' }), { 'Content-Type': 'application/json' });
    url.pathname = path;
    const request = new Request(url, { method: req.method, headers, body });
    const response = await fn(request, {});
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) });
    return res.end(req.method === 'HEAD' ? undefined : out);
  }

  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '', { Allow: 'GET, HEAD' });
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!staticFiles.has(name)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = await readFile(new URL('../public/' + name, import.meta.url));
  return send(res, 200, req.method === 'HEAD' ? '' : file, { 'Content-Type': types[name.split('.').pop()] });
}

const server = http.createServer((req, res) => {
  const begin = Date.now();
  handle(req, res).catch(error => {
    console.error('Request failed', req.method, req.url.split('?')[0], error.message);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'Server error' }), { 'Content-Type': 'application/json' });
    else res.end();
  }).finally(() => {
    // Paths only. No query strings, headers or bodies in logs. Token URLs are masked.
    if (req.url !== '/health') console.log(new Date().toISOString(), req.method, req.url.split('?')[0].replace(/^\/mcp\/.+$/, '/mcp/***'), res.statusCode, Date.now() - begin + 'ms');
  });
});
server.requestTimeout = 60000;
server.headersTimeout = 20000;

// The two Netlify scheduled jobs, run in process.
const timers = [];
if (env.SCHEDULER !== 'off') {
  const every = (minutes, job, label) => timers.push(setInterval(() => job().catch(error => console.log(label + ' failed', error.message)), minutes * 60000));
  if (scheduled['alerts-scheduled.mjs']) every(15, () => scheduled['alerts-scheduled.mjs'](), 'Alert check');
  every(30, async () => {
    if (!mailSettings(env).enabled) return;
    const snapshot = await syncMailbox({ env, store: await openStore() });
    console.log('JARVIS mail sync', snapshot.messages.length, 'messages');
  }, 'JARVIS mail sync');
}

const port = Number(env.PORT || 8080);
server.listen(port, env.HOST || '0.0.0.0', () => {
  console.log('A2Z MCP server on port ' + port + ' · storage ' + (supabase ? 'supabase' : 'local disk') + ' · routes ' + Object.keys(routes).length +
    ' · URL token ' + (env.MCP_URL_TOKEN === 'on' ? 'on' : 'off') + ' · data ' + (env.DATA_MODE === 'sample' ? 'sample' : 'live'));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    timers.forEach(clearInterval);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
