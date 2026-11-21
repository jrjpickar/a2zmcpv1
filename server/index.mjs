// A2Z MCP server for Docker and VM deploys (for example a Google Cloud e2-micro with the port on localhost only).
// It runs the same function handlers as Netlify: dashboard, JARVIS and the MCP endpoint (Streamable HTTP, JSON responses).
// Netlify deploys do not use this file.
//
// Env: MCP_AUTH_TOKEN (required, 16+ characters) protects /mcp with "Authorization: Bearer <token>".
//      MCP_URL_TOKEN=on also accepts POST /mcp/<token> for clients that cannot send headers. Off by default.
//      SUPABASE_URL + SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) store JARVIS memory in Supabase, else DATA_DIR/jarvis on disk.
//      PORT (default 8080), HOST (default 127.0.0.1), DATA_DIR (default /data), SCHEDULER=off disables the 15 and 30 minute jobs.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
const { memoryStore: voiceMemory } = await import('../netlify/functions/lib/voice/state.mjs');
const voiceStore = voiceMemory();
const { classifyTopic } = await import('../netlify/functions/lib/classify-topic.mjs');
const { createJarvisHandler } = await import('../netlify/functions/jarvis.mjs');
const { createJarvisMemoryHandler } = await import('../netlify/functions/jarvis-memory.mjs');
const { createExecuteHandler } = await import('../netlify/functions/jarvis-execute.mjs');
const { createInstructionsHandler } = await import('../netlify/functions/jarvis-instructions.mjs');
const { dashboardAccess } = await import('../netlify/functions/lib/dashboard-auth.mjs');
const { startSlackSocket } = await import('./slack-socket.mjs');
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
routes['/api/jarvis'] = createJarvisHandler({ openStore, classifier: classifyTopic });
routes['/api/jarvis-memory'] = createJarvisMemoryHandler({ openStore, classifier: classifyTopic });
routes['/api/jarvis-execute'] = createExecuteHandler({ openStore });
routes['/api/jarvis-instructions'] = createInstructionsHandler({ openStore });
const bodyLimits = { '/api/ask': 550000, '/api/jarvis': 16384, '/api/jarvis-memory': 8192, '/api/jarvis-execute': 16384, '/mcp': 16384 };

// Same response headers as netlify.toml.
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; frame-ancestors 'self' https://app.gohighlevel.com https://app.leadconnectorhq.com",
};
const types = { html: 'text/html; charset=utf-8', js: 'application/javascript', mjs: 'application/javascript', css: 'text/css' };
// Every top-level file in public/ with a known type, read once at startup, so new modules are never left out.
const staticFiles = new Set((await readdir(new URL('../public/', import.meta.url), { withFileTypes: true }))
  .filter(entry => entry.isFile() && /^[\w.-]+$/.test(entry.name) && Object.hasOwn(types, entry.name.split('.').pop())).map(entry => entry.name));
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

const sessionAge = 8 * 60 * 60;
const sessionName = '__Host-a2z-session';
const loginAttempts = new Map();
function checkLoginLimit(headers, remoteAddress) {
  const address = headers['x-forwarded-for']?.split(',').at(-1)?.trim() || remoteAddress;
  const now = Date.now();
  const attempt = loginAttempts.get(address);
  if (attempt && attempt.until > now) {
    if (attempt.count >= 20) return false;
    attempt.count++;
  } else {
    loginAttempts.delete(address);
    if (loginAttempts.size >= 500) loginAttempts.delete(loginAttempts.keys().next().value);
    loginAttempts.set(address, { count: 1, until: now + 60000 });
  }
  return true;
}
const loginPage = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>A2Z sign in</title><h1>A2Z Operations</h1><form method="post" action="/login"><label>Dashboard access key <input name="key" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></html>';
const sessionSignature = expires => createHmac('sha256', token).update('dashboard:' + digest(env.DASHBOARD_KEY || '').toString('hex') + ':' + expires).digest('base64url');

function hasSession(headers) {
  if ((env.DASHBOARD_KEY || '').length < 16) return false;
  const cookie = (headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(sessionName + '='));
  const match = /^(\d{10})\.([\w-]{43})$/.exec(cookie?.slice(sessionName.length + 1) || '');
  return Boolean(match && Number(match[1]) > Math.floor(Date.now() / 1000) &&
    timingSafeEqual(digest(match[2]), digest(sessionSignature(match[1]))));
}

async function handle(req, res) {
  // Only this host reaches the port (compose binds 127.0.0.1), so a forwarded scheme from a local proxy is trusted.
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return send(res, 400, 'Invalid request path.');
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

  const isSecure = url.protocol === 'https:';
  const session = isSecure && hasSession(headers);
  if (path === '/login' && req.method === 'POST') {
    const sameOrigin = headers.origin === url.origin ||
      (headers.origin === 'null' && headers['sec-fetch-site'] === 'same-origin');
    if (!isSecure || !sameOrigin) return send(res, 403, 'Sign in requires same-origin HTTPS.');
    if (!checkLoginLimit(headers, req.socket.remoteAddress)) return send(res, 429, 'Try signing in again in a minute.', { 'Retry-After': '60' });
    const body = await readRequestBody(req, 2048);
    if (!body) return send(res, 413, 'Request too large.');
    const key = new URLSearchParams(body.toString()).get('key') || '';
    if ((env.DASHBOARD_KEY || '').length < 16 || !timingSafeEqual(digest(key), digest(env.DASHBOARD_KEY))) {
      return send(res, 401, loginPage, { 'Content-Type': types.html });
    }
    const expires = Math.floor(Date.now() / 1000) + sessionAge;
    return send(res, 303, '', {
      Location: '/',
      'Set-Cookie': sessionName + '=' + expires + '.' + sessionSignature(expires) + '; Max-Age=' + sessionAge + '; Path=/; Secure; HttpOnly; SameSite=Lax',
    });
  }

  // Existing signed callbacks and token-based integrations authenticate in their handlers.
  const protocolRoute = path === '/mcp' || path.startsWith('/mcp/') ||
    ['/api/highlevel/session', '/api/highlevel/install', '/api/slack/events', '/api/slack/voice', '/api/voice'].includes(path) ||
    (path === '/api/ask' && Boolean(headers['x-a2z-voice']));
  if (session) {
    if (!headers['x-a2z-session']) headers['x-a2z-key'] = env.DASHBOARD_KEY;
    if (!['GET', 'HEAD'].includes(req.method) && headers.origin !== url.origin) return send(res, 403, 'Origin rejected.');
  } else if (!protocolRoute && !dashboardAccess(new Request(url, { headers }), env)) {
    if ((path === '/' || path === '/index.html') && ['GET', 'HEAD'].includes(req.method)) {
      return send(res, 401, req.method === 'HEAD' ? '' : loginPage, { 'Content-Type': types.html });
    }
    return send(res, 401, JSON.stringify({ error: 'Sign in required.' }), {
      'Content-Type': 'application/json', 'X-A2Z-Login': 'required',
    });
  }

  // Optional token-in-URL form for connectors that cannot send an Authorization header.
  const urlToken = /^\/mcp\/([A-Za-z0-9._~-]{16,200})$/.exec(path);
  if (urlToken) {
    if (env.MCP_URL_TOKEN !== 'on' || !tokenMatches(urlToken[1])) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    headers.authorization = 'Bearer ' + token;
    path = '/mcp';
  }

  if (path === '/api/slack/events' && env.SLACK_APP_TOKEN) return send(res, 404, '');
  const fn = routes[path];
  if (fn) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequestBody(req, bodyLimits[path] || 65536);
    if (body === null) return send(res, 413, JSON.stringify({ error: 'Request body exceeds the size limit.' }), { 'Content-Type': 'application/json' });
    url.pathname = path;
    const request = new Request(url, { method: req.method, headers, body });
    const response = await fn(request, {
      openStore,
      ...((path === '/api/voice' || (path === '/api/ask' && headers['x-a2z-voice'])) && { store: voiceStore }),
      voiceOrigin: url.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.host) ? url.origin : undefined,
    });
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      ...securityHeaders, ...Object.fromEntries(response.headers),
      ...(path === '/api/metrics' && session && !headers['x-a2z-session'] ? { 'X-A2Z-Live': 'websocket' } : {}),
    });
    return res.end(req.method === 'HEAD' ? undefined : out);
  }

  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '', { Allow: 'GET, HEAD' });
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!staticFiles.has(name)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = await readFile(new URL('../public/' + name, import.meta.url));
  return send(res, 200, req.method === 'HEAD' ? '' : file, { 'Content-Type': types[name.split('.').pop()] });
}

const pathForLog = url => url.split('?')[0].replace(/^\/mcp\/.+$/, '/mcp/***');
const server = http.createServer((req, res) => {
  const begin = Date.now();
  handle(req, res).catch(error => {
    console.error('Request failed', req.method, pathForLog(req.url), error.message);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'Server error' }), { 'Content-Type': 'application/json' });
    else res.end();
  }).finally(() => {
    // Paths only. No query strings, headers or bodies in logs. Token URLs are masked.
    if (req.url !== '/health') console.log(new Date().toISOString(), req.method, pathForLog(req.url), res.statusCode, Date.now() - begin + 'ms');
  });
});
server.requestTimeout = 60000;
server.headersTimeout = 20000;

const live = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
const subscribers = new Map();
let liveTimer, mailUpdate, latestMail;
function sendMail(socket, client, snapshot) {
  if (client.fingerprint === snapshot.fingerprint || socket.readyState !== 1) return;
  socket.send(snapshot.event);
  client.fingerprint = snapshot.fingerprint;
}
function tickMail() {
  if (mailUpdate || !subscribers.size) return;
  mailUpdate = (async () => {
    const response = await routes['/api/mail'](new Request('http://localhost/api/mail', {
      headers: { 'x-a2z-key': env.DASHBOARD_KEY },
    }));
    const mail = await response.json();
    const fingerprint = JSON.stringify([mail.status, mail.stats, mail.arrivalSequence]);
    const event = JSON.stringify({ type: 'mail', mail });
    latestMail = { fingerprint, event, at: Date.now() };
    for (const [socket, client] of subscribers) {
      if (!hasSession(client.headers)) { socket.close(1008, 'Session expired'); continue; }
      if ((client.pingAt && Date.now() - client.pingAt >= 25000) || socket.bufferedAmount > 65536) { socket.terminate(); continue; }
      if (socket.readyState !== 1) continue;
      if (!client.pingAt) {
        client.pingAt = Date.now();
        socket.ping();
      }
      sendMail(socket, client, latestMail);
    }
  })().catch(error => console.error('Live mail refresh failed', error.message)).finally(() => { mailUpdate = null; });
}

server.on('upgrade', (request, socket, head) => {
  const host = request.headers.host;
  const allowed = host && request.url === '/live' && request.headers['x-forwarded-proto'] === 'https' &&
    request.headers.origin === 'https://' + host && hasSession(request.headers);
  if (!allowed || subscribers.size >= 100) {
    socket.end('HTTP/1.1 ' + (allowed ? '503 Service Unavailable' : '401 Unauthorized') + '\r\nConnection: close\r\n\r\n');
    return;
  }
  live.handleUpgrade(request, socket, head, client => {
    const state = { headers: request.headers, pingAt: null };
    subscribers.set(client, state);
    client.on('error', () => client.terminate());
    client.on('pong', () => { state.pingAt = null; });
    client.on('close', () => {
      subscribers.delete(client);
      if (!subscribers.size) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    });
    liveTimer ||= setInterval(tickMail, 30000);
    if (latestMail && Date.now() - latestMail.at < 30000) sendMail(client, state, latestMail);
    else tickMail();
  });
});

// The two Netlify scheduled jobs, run in process.
const timers = [];
if (env.SCHEDULER !== 'off') {
  const every = (minutes, job, label) => {
    let running = false;
    timers.push(setInterval(async () => {
      if (running) return;
      running = true;
      try { await job(); }
      catch (error) { console.log(label + ' failed', error.message); }
      finally { running = false; }
    }, minutes * 60000));
  };
  if (scheduled['alerts-scheduled.mjs']) every(15, () => scheduled['alerts-scheduled.mjs'](), 'Alert check');
  every(30, async () => {
    if (!mailSettings(env).enabled) return;
    const snapshot = await syncMailbox({ env, store: await openStore() });
    console.log('JARVIS mail sync', snapshot.messages.length, 'messages');
  }, 'JARVIS mail sync');
}

const stopSlack = startSlackSocket({
  env, openStore, jarvis: routes['/api/jarvis'], memory: routes['/api/jarvis-memory'], execute: routes['/api/jarvis-execute'],
});
const port = Number(env.PORT || 8080);
server.listen(port, env.HOST || '127.0.0.1', () => {
  console.log('A2Z MCP server on port ' + port + ' · storage ' + (supabase ? 'supabase' : 'local disk') + ' · routes ' + Object.keys(routes).length +
    ' · URL token ' + (env.MCP_URL_TOKEN === 'on' ? 'on' : 'off') + ' · data ' + (env.DATA_MODE === 'sample' ? 'sample' : 'live'));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopSlack();
    timers.forEach(clearInterval);
    clearInterval(liveTimer);
    for (const socket of subscribers.keys()) socket.terminate();
    live.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
