import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { freemem, totalmem, loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { complete, routeId, routes } from './providers.mjs';

const digest = value => createHash('sha256').update(value).digest();
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
const activeStates = new Set(['approval', 'queued', 'running']);
const profileNames = new Set(['engineering', 'operations', 'estimating', 'finance',
  'dispatch', 'sales', 'infrastructure', 'research', 'security', 'quality assurance']);
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

export function createRuntime(env = process.env, fetchImpl = fetch) {
  if ((env.JOSE_TOKEN || '').length < 32) throw new Error('Set JOSE_TOKEN (32+ characters)');
  const dir = env.JOSE_STATE_DIR || './jose-state';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'state.json');
  const state = readJson(path, { tasks: [], stopped: false, usage: {}, events: [], monitors: {} });
  const configPath = env.JOSE_CONFIG || '/etc/a2z-jose/config.json';
  let config = {};
  let configError = false;
  let running = null;
  let tools = { status: 'unconfigured', catalog: state.catalog || [] };
  let lastDiscovery = 0;
  let ticking = false;
  let gateway = 'unconfigured';
  const started = Date.now();

  function refresh() {
    try {
      const next = readJson(configPath, {});
      if (!next || typeof next !== 'object' || Array.isArray(next) ||
        ['models', 'monitors'].some(key => key in next && (!Array.isArray(next[key]) ||
          next[key].length > 30 || next[key].some(item => !item || typeof item !== 'object')))) {
        throw new Error('Invalid config');
      }
      config = next;
      configError = false;
    } catch { configError = true; }
  }

  function save() {
    writeFileSync(path + '.tmp', JSON.stringify(state), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  }

  function event(type, taskId = null) {
    state.events.unshift({ type, taskId, at: Date.now() });
    state.events.length = Math.min(state.events.length, 100);
    save();
  }

  for (const task of state.tasks) {
    if (task.status === 'running') {
      task.status = 'queued';
      event('recovered', task.id);
    }
  }

  async function discover() {
    if (!env.JOSE_MCP_URL || !env.JOSE_MCP_READ_TOKEN) return;
    try {
      const target = new URL(env.JOSE_MCP_URL);
      if (target.protocol !== 'https:' && !(target.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error();
      const response = await fetchImpl(target, { method: 'POST', redirect: 'error',
        headers: { authorization: 'Bearer ' + env.JOSE_MCP_READ_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal: AbortSignal.timeout(4000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const data = await response.json();
      const catalog = data.result.tools.filter(tool => typeof tool?.name === 'string').slice(0, 100)
        .map(tool => ({
          name: tool.name.slice(0, 100),
          description: typeof tool.description === 'string' ? tool.description.slice(0, 240) : '',
          contract: digest(JSON.stringify(canonical(tool.inputSchema || {}))).toString('hex'),
          required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required
            .filter(key => typeof key === 'string').slice(0, 30).map(key => key.slice(0, 100)).sort() : [],
        })).sort((a, b) => a.name.localeCompare(b.name));
      if (JSON.stringify(state.catalog) !== JSON.stringify(catalog)) {
        state.catalog = catalog;
        event('MCP tool catalog updated');
      }
      tools = { status: 'ok', catalog, at: Date.now() };
    } catch { tools = { status: 'unavailable', catalog: state.catalog || [], at: Date.now() }; }
  }

  async function checkGateway() {
    if (!env.JOSE_OPENCLAW_GATEWAY_TOKEN) return;
    try {
      const response = await fetchImpl('http://127.0.0.1:18789/v1/models', {
        headers: { authorization: 'Bearer ' + env.JOSE_OPENCLAW_GATEWAY_TOKEN },
        redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      gateway = response.ok ? 'reachable' : 'unavailable';
      await response.body?.cancel();
    } catch { gateway = 'unavailable'; }
  }

  async function monitor(now) {
    const entries = (config.monitors || []).filter(entry => /^[\w-]{1,40}$/.test(entry.id || '') &&
      ['mcp', 'memory', 'https'].includes(entry.kind));
    let changed = false;
    for (const key of Object.keys(state.monitors)) {
      if (entries.some(entry => entry.id === key)) continue;
      delete state.monitors[key];
      changed = true;
    }
    for (const entry of entries) {
      const old = Object.hasOwn(state.monitors, entry.id) ? state.monitors[entry.id] : null;
      if (old && now - old.at < Math.max(15, Number(entry.seconds) || 60) * 1000) continue;
      let ok = false;
      if (entry.kind === 'mcp') ok = tools.status === 'ok';
      if (entry.kind === 'memory') ok = freemem() / 1048576 >= (Number(entry.minFreeMiB) || 100);
      if (entry.kind === 'https') {
        try {
          const target = new URL(entry.url);
          if (target.protocol !== 'https:' || target.username || target.password) throw new Error();
          const response = await fetchImpl(target, { method: 'HEAD', redirect: 'error',
            signal: AbortSignal.timeout(3000) });
          ok = response.ok;
        } catch { /* Failed check is recorded below. */ }
      }
      Object.defineProperty(state.monitors, entry.id, { value: { ok, at: now }, enumerable: true,
        configurable: true, writable: true });
      changed = true;
      if (old?.ok !== ok) event('monitor ' + entry.id + (ok ? ' healthy' : ' failed'));
    }
    if (changed) save();
  }

  function usage(key, now) {
    const day = Math.floor(now / 86400000);
    const minute = Math.floor(now / 60000);
    const entry = state.usage[key] ||= {};
    if (entry.day !== day) Object.assign(entry, { day, requests: 0, tokens: 0 });
    if (entry.minute !== minute) Object.assign(entry, { minute, recent: 0, recentTokens: 0 });
    return entry;
  }

  function choose(task, now) {
    const reserve = Buffer.byteLength(task.prompt) + 800;
    const configured = configError ? [] : routes(config, env);
    const candidates = configured.filter(route => !route.profiles || route.profiles.includes(task.profile));
    return candidates.filter(route => {
      const model = usage(routeId(route), now);
      const shared = usage(route.provider, now);
      const accountRoutes = configured.filter(other => other.provider === route.provider);
      return reserve <= route.context && (model.until || 0) <= now && (shared.until || 0) <= now &&
        model.tokens + reserve <= route.tpd && model.recentTokens + reserve <= route.tpm &&
        shared.requests < Math.min(...accountRoutes.map(other => other.rpd)) &&
        shared.recent < Math.min(...accountRoutes.map(other => other.rpm));
    }).sort((a, b) => Number(a.provider === task.provider && a.model === task.model) -
      Number(b.provider === task.provider && b.model === task.model))[0];
  }

  async function execute(task, route, now) {
    const controller = new AbortController();
    running = { id: task.id, controller };
    const model = usage(routeId(route), now);
    const shared = usage(route.provider, now);
    const reserve = Buffer.byteLength(task.prompt) + 800;
    model.tokens += reserve;
    model.recentTokens += reserve;
    shared.requests++;
    shared.recent++;
    Object.assign(task, { status: 'running', provider: route.provider, model: route.model,
      reason: 'Configured profile and rank, available quota and context', attempts: task.attempts + 1 });
    event('started', task.id);
    try {
      const result = await complete(route, task, env,
        AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]), fetchImpl);
      if (task.status !== 'running') return;
      if (result.tokens !== null) {
        model.tokens += result.tokens - reserve;
        model.recentTokens += result.tokens - reserve;
      }
      model.failures = 0;
      Object.assign(task, result, { status: 'completed' });
      event('completed', task.id);
    } catch (error) {
      if (task.status !== 'running') return;
      model.failures = (model.failures || 0) + 1;
      model.until = Date.now() + Math.max(Math.min(900000, 2000 * 2 ** Math.min(9, model.failures)),
        Number.isFinite(error.retryMs) ? error.retryMs : 0);
      if ([401, 402, 403, 429].includes(error.status)) shared.until = model.until;
      task.status = task.attempts >= 8 ? 'failed' : 'queued';
      task.nextAt = Date.now() + 2000;
      event(error.status ? 'provider HTTP ' + error.status : 'provider request failed', task.id);
    } finally { running = null; }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      refresh();
      const now = Date.now();
      if (now - lastDiscovery >= 60000) {
        lastDiscovery = now;
        await Promise.all([discover(), checkGateway()]);
      }
      await monitor(now);
      if (state.stopped) return;
      const dispatchAt = Date.now();
      const queued = state.tasks.filter(task => task.status === 'queued' && task.nextAt <= dispatchAt);
      for (const task of queued.sort((a, b) => b.priority - a.priority || a.created - b.created)) {
        const route = choose(task, dispatchAt);
        if (!route) continue;
        await execute(task, route, dispatchAt);
        break;
      }
    } finally { ticking = false; }
  }

  const status = () => ({
    ...state, tools, gateway, configError, profiles: [...profileNames],
    providers: routes(config, env).map(route => ({
      provider: route.provider, model: route.model, limits: { rpm: route.rpm, rpd: route.rpd,
        tpm: route.tpm, tpd: route.tpd }, modelUsage: { ...usage(routeId(route), Date.now()) },
      accountUsage: { ...usage(route.provider, Date.now()) },
    })),
    uptimeSeconds: Math.floor((Date.now() - started) / 1000),
    rssMiB: process.memoryUsage.rss() / 1048576, hostFreeMiB: freemem() / 1048576,
    hostTotalMiB: totalmem() / 1048576, loadAverage: loadavg(),
  });

  function command(input) {
    if (input?.action === 'submit') {
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 3000 ||
        input.publicData !== true || !profileNames.has(input.profile)) return 400;
      if (state.tasks.filter(task => activeStates.has(task.status)).length >= 40) return 409;
      if (state.tasks.length >= 100) {
        const index = state.tasks.findLastIndex(task => !activeStates.has(task.status));
        state.tasks.splice(index, 1);
      }
      const now = Date.now();
      const task = { id: randomUUID(), prompt: input.prompt.trim(), attempts: 0,
        profile: input.profile, priority: input.priority === true ? 1 : 0,
        created: now, nextAt: Number.isSafeInteger(input.startAt) ? Math.max(now, input.startAt) : now,
        status: input.approval === true ? 'approval' : 'queued' };
      state.tasks.unshift(task);
      event('submitted', task.id);
      return 201;
    }
    const task = state.tasks.find(entry => entry.id === input?.id);
    if (input?.action === 'stop' || input?.action === 'resume') {
      state.stopped = input.action === 'stop';
      if (state.stopped && running) {
        const current = state.tasks.find(entry => entry.id === running.id);
        if (current.status === 'running') current.status = 'queued';
        running.controller.abort();
      }
      event(input.action);
      return 200;
    }
    if (input?.action === 'cancel' && task && activeStates.has(task.status)) {
      task.status = 'canceled';
      if (running?.id === task.id) running.controller.abort();
      event('canceled', task.id);
      return 200;
    }
    if (input?.action === 'approve' && task?.status === 'approval') {
      task.status = 'queued';
      event('approved', task.id);
      return 200;
    }
    return 409;
  }

  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!timingSafeEqual(digest(req.headers.authorization || ''), digest('Bearer ' + env.JOSE_TOKEN))) {
      return send(401, { error: 'Unauthorized' });
    }
    if (req.url !== '/jose') return send(404, { error: 'Unknown endpoint' });
    if (req.method === 'GET') return send(200, status());
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16000) return send(413, { error: 'Payload too large' });
        chunks.push(chunk);
      }
    } catch { return; }
    const raw = Buffer.concat(chunks).toString('utf8');
    let input;
    try { input = JSON.parse(raw); }
    catch { return send(400, { error: 'Invalid JSON' }); }
    const code = command(input);
    return send(code, code < 400 ? { ok: true } : { error: 'Invalid request or task state' });
  });
  refresh();
  return { server, tick, status, command };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createRuntime();
  runtime.server.listen(Number(process.env.JOSE_PORT || 8789), '127.0.0.1');
  await runtime.tick();
  setInterval(() => runtime.tick().catch(error => {
    console.error('JOSE scheduler failed:', error.code || error.name);
    process.exit(1);
  }), 2000);
}
