// A2Z Jose edge worker (Cloudflare Workers). Read-only GHL lookups for Jose, cached.
//
// POST /v1/jobs/search { query, pipelines?, won?, limit?, fresh? }
//   Opportunities matching a spoken address or name, ranked, across the four A2Z pipelines:
//   demo (GHL_PIPELINE_ID), labor (LABOR_PIPELINE_ID, else the pipeline named "Labor"),
//   containers (CONTAINER_PIPELINE_ID) and change_orders (CHANGE_ORDER_PIPELINE_ID).
//   pipelines: a subset of those keys (default all four). Each job carries its pipeline key and name.
//   won: true keeps won jobs only (status won, or stage Job Awarded, Accepted, Work In Progress, Job Completed).
// POST /v1/texts { contactId? | query? | unread: true, limit?, fresh? }
//   SMS only. contactId or query: the newest messages of that contact's conversation.
//   unread: conversations with unread messages, newest first.
// GET /health
//
// Auth: Authorization: Bearer <EDGE_KEY>. Writes never pass through here: change orders and
// proposals go MCP -> Desk jarvis-actions with the Desk's preview, hash and confirm.
//
// Cache: per isolate memory first, then KV (binding CACHE). The Cache API does nothing on
// workers.dev, so KV is the shared layer. Keys are SHA-256 hashes, never raw phone numbers or
// queries. KV keeps entries 60 s at least (its minimum TTL); the stored expiry enforces shorter
// lifetimes. fresh: true skips both layers. Free plan: KV allows 1,000 writes per day.
const GHL = 'https://services.leadconnectorhq.com';
const WON = ['job awarded', 'accepted', 'work in progress', 'job completed'];
const PIPELINE_KEYS = ['demo', 'labor', 'containers', 'change_orders'];
const DEFAULTS = { CONTAINER_PIPELINE_ID: 'F8i8hB7E5xHrJbJUXFr4', CHANGE_ORDER_PIPELINE_ID: 'Nvk3EKhRzg5omo4BLCOK' };
const TTL = { pipelines: 3600, jobs: 120, texts: 30, unread: 20 };
const MEMORY_MAX = 200;
const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fault = (status, message) => Object.assign(new Error(message), { status });
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function sha(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function cacheKey(...parts) {
  return 'v1:' + [...await sha(JSON.stringify(parts))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Rank by shared words. A leading street number that matches counts most.
export function score(query, name) {
  const q = norm(query).split(' ').filter(Boolean);
  const n = norm(name);
  const words = new Set(n.split(' '));
  let points = q.filter(word => words.has(word)).length;
  if (/^\d+$/.test(q[0] || '') && n.startsWith(q[0] + ' ')) points += 2;
  return points;
}

export function createWorker({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const memory = new Map();

  async function cached(env, ctx, key, ttl, fresh, load) {
    const at = now();
    if (!fresh) {
      const hit = memory.get(key);
      if (hit && hit.expires > at) return { value: hit.value, cache: 'memory' };
      const stored = env.CACHE ? await env.CACHE.get(key, 'json').catch(() => null) : null;
      if (stored && stored.expires > at) {
        remember(key, stored);
        return { value: stored.value, cache: 'kv' };
      }
    }
    const entry = { expires: at + ttl * 1000, value: await load() };
    remember(key, entry);
    if (env.CACHE) {
      const put = env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, ttl) }).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
    }
    return { value: entry.value, cache: 'miss' };
  }
  function remember(key, entry) {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
    memory.set(key, entry);
  }

  async function ghl(env, path, version = '2021-07-28') {
    const response = await fetchImpl(GHL + path, {
      headers: { Authorization: 'Bearer ' + env.GHL_PIT_TOKEN, Version: version, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (response.status === 401 || response.status === 403) throw fault(502, 'GHL refused the token. Check the PIT scopes.');
    if (response.status === 429) throw fault(429, 'GHL rate limit reached. Retry shortly.');
    if (!response.ok) throw fault(502, 'GHL request failed (HTTP ' + response.status + ').');
    return response.json();
  }

  // { stages: { stageId: name }, pipelines: [{ id, name }] }, cached 1 hour.
  async function catalog(env, ctx) {
    const key = await cacheKey('pipelines-v2', env.GHL_LOCATION_ID);
    const { value } = await cached(env, ctx, key, TTL.pipelines, false, async () => {
      const data = await ghl(env, '/opportunities/pipelines?locationId=' + encodeURIComponent(env.GHL_LOCATION_ID));
      const list = data.pipelines || [];
      return {
        stages: Object.fromEntries(list.flatMap(p => (p.stages || []).map(stage => [stage.id, stage.name]))),
        pipelines: list.filter(p => p?.id).map(p => ({ id: p.id, name: String(p.name || '').trim() })),
      };
    });
    return value;
  }

  // Pipeline key -> { id, name }. Labor is matched by name when LABOR_PIPELINE_ID is not set, like the MCP report.
  function pipelineMap(env, list) {
    const byId = id => list.find(p => p.id === id);
    const ids = {
      demo: env.GHL_PIPELINE_ID,
      labor: env.LABOR_PIPELINE_ID || list.find(p => /^labor\b/i.test(p.name))?.id,
      containers: env.CONTAINER_PIPELINE_ID || DEFAULTS.CONTAINER_PIPELINE_ID,
      change_orders: env.CHANGE_ORDER_PIPELINE_ID || DEFAULTS.CHANGE_ORDER_PIPELINE_ID,
    };
    return Object.fromEntries(Object.entries(ids).filter(([, id]) => id && byId(id)).map(([key, id]) => [key, { id, name: byId(id).name }]));
  }

  async function searchJobs(env, ctx, body) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 2 || query.length > 120) throw fault(400, 'query must be 2 to 120 characters.');
    const wanted = body.pipelines === undefined ? PIPELINE_KEYS : body.pipelines;
    if (!Array.isArray(wanted) || !wanted.length || wanted.some(key => !PIPELINE_KEYS.includes(key))) throw fault(400, 'pipelines must be a list of ' + PIPELINE_KEYS.join(', ') + '.');
    const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 10);
    const won = body.won === true;
    const { stages, pipelines } = await catalog(env, ctx);
    const map = pipelineMap(env, pipelines);
    const keys = [...new Set(wanted)].filter(key => map[key]);
    let cache = 'memory';
    const order = { memory: 0, kv: 1, miss: 2 };
    const results = await Promise.all(keys.map(async pipeline => {
      const { id, name } = map[pipeline];
      const key = await cacheKey('jobs', env.GHL_LOCATION_ID, id, norm(query));
      const hit = await cached(env, ctx, key, TTL.jobs, body.fresh === true, async () => {
        const params = new URLSearchParams({ location_id: env.GHL_LOCATION_ID, pipeline_id: id, q: query, status: 'all', limit: '50' });
        const data = await ghl(env, '/opportunities/search?' + params);
        return (data.opportunities || []).filter(o => o.pipelineId === id).map(o => ({
          id: o.id, name: o.name || '', stageId: o.pipelineStageId || '', status: String(o.status || '').toLowerCase(),
          contactName: o.contact?.name || '', companyName: o.contact?.companyName || '', updatedAt: o.updatedAt || o.lastStatusChangeAt || '',
        }));
      });
      if (order[hit.cache] > order[cache]) cache = hit.cache;
      return hit.value.map(row => ({ ...row, pipeline, pipelineName: name }));
    }));
    const jobs = results.flat().map(row => ({ ...row, stage: stages[row.stageId] || '', score: score(query, row.name) }))
      .filter(row => !won || row.status === 'won' || WON.includes(String(row.stage).toLowerCase()))
      .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
      .map(({ stageId, ...row }) => row);
    return { jobs, pipelines: keys, cache };
  }

  const sms = message => /sms/i.test(String(message.messageType || message.type || ''));
  const shapeMessage = m => ({ direction: m.direction === 'outbound' ? 'outbound' : 'inbound', body: String(m.body || '').slice(0, 600), at: m.dateAdded || '' });

  async function readTexts(env, ctx, body) {
    const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20);
    const fresh = body.fresh === true;
    const base = { locationId: env.GHL_LOCATION_ID };
    if (body.unread === true) {
      const key = await cacheKey('unread', env.GHL_LOCATION_ID, limit);
      const { value, cache } = await cached(env, ctx, key, TTL.unread, fresh, async () => {
        const data = await ghl(env, '/conversations/search?' + new URLSearchParams({ ...base, status: 'unread', limit: String(limit), sort: 'desc', sortBy: 'last_message_date' }), '2021-04-15');
        return (data.conversations || []).filter(c => /sms/i.test(String(c.lastMessageType || ''))).map(c => ({
          contactId: c.contactId, contactName: c.fullName || c.contactName || c.phone || 'Unknown', unreadCount: c.unreadCount || 0,
          lastBody: String(c.lastMessageBody || '').slice(0, 300), at: c.lastMessageDate || '',
        }));
      });
      return { conversations: value, cache };
    }
    const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : '';
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (contactId && !/^[A-Za-z0-9]{6,64}$/.test(contactId)) throw fault(400, 'Invalid contactId.');
    if (!contactId && (query.length < 2 || query.length > 120)) throw fault(400, 'Send contactId, query or unread.');
    const key = await cacheKey('texts', env.GHL_LOCATION_ID, contactId || norm(query), limit);
    const { value, cache } = await cached(env, ctx, key, TTL.texts, fresh, async () => {
      const found = await ghl(env, '/conversations/search?' + new URLSearchParams({ ...base, limit: '5', ...(contactId ? { contactId } : { query }) }), '2021-04-15');
      const conversations = found.conversations || [];
      if (!conversations.length) return { matches: [] };
      const people = [...new Map(conversations.map(c => [c.contactId, c])).values()];
      if (!contactId && people.length > 1) {
        return { matches: people.slice(0, 5).map(c => ({ contactId: c.contactId, contactName: c.fullName || c.contactName || c.phone || 'Unknown' })) };
      }
      const conversation = conversations[0];
      const data = await ghl(env, '/conversations/' + encodeURIComponent(conversation.id) + '/messages?' + new URLSearchParams({ limit: String(Math.min(limit * 3, 60)) }), '2021-04-15');
      const list = Array.isArray(data.messages) ? data.messages : data.messages?.messages || [];
      return {
        contact: { contactId: conversation.contactId, contactName: conversation.fullName || conversation.contactName || conversation.phone || 'Unknown' },
        messages: list.filter(sms).slice(0, limit).map(shapeMessage),
      };
    });
    return { ...value, cache };
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
      try {
        if (!(await sameSecret((request.headers.get('authorization') || '').replace(/^Bearer /, ''), env.EDGE_KEY))) throw fault(401, 'Unauthorized.');
        if (!env.GHL_PIT_TOKEN || !env.GHL_LOCATION_ID || !env.GHL_PIPELINE_ID) throw fault(503, 'The edge worker is not configured.');
        if (request.method !== 'POST') throw fault(405, 'POST required.');
        if ((request.headers.get('content-type') || '').split(';')[0] !== 'application/json') throw fault(415, 'Expected JSON.');
        const text = await request.text();
        if (text.length > 4096) throw fault(413, 'Request too large.');
        let body;
        try { body = JSON.parse(text); } catch { throw fault(400, 'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault(400, 'Invalid JSON.');
        if (url.pathname === '/v1/jobs/search') return json(await searchJobs(env, ctx, body));
        if (url.pathname === '/v1/texts') return json(await readTexts(env, ctx, body));
        throw fault(404, 'Not found.');
      } catch (error) {
        return json({ error: error.status ? error.message : 'Edge lookup failed.' }, error.status || 502);
      }
    },
  };
}

export default createWorker();
