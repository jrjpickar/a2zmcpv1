import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker, score } from '../edge/src/index.mjs';

const kv = () => {
  const data = new Map();
  return { data, async get(key) { return data.has(key) ? JSON.parse(data.get(key)) : null; }, async put(key, value, opts) { assert.ok(opts.expirationTtl >= 60); data.set(key, value); } };
};
const env = (extra = {}) => ({ EDGE_KEY: 'edge-secret', GHL_PIT_TOKEN: 'pit', GHL_LOCATION_ID: 'loc', GHL_PIPELINE_ID: 'main', CACHE: kv(), ...extra });
const call = (worker, e, path, body, key = 'edge-secret') => worker.fetch(new Request('https://edge.example' + path, {
  method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), e, { waitUntil: () => {} }).then(async r => ({ status: r.status, data: await r.json() }));

function ghl(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), version: options.headers.Version });
    assert.equal(options.headers.Authorization, 'Bearer pit');
    const route = routes[u.pathname] ?? routes[u.pathname.replace(/[^/]+\/messages$/, ':id/messages')];
    return Response.json(typeof route === 'function' ? route(u) : route);
  };
  return { calls, fetchImpl };
}
const pipelines = { pipelines: [
  { id: 'main', name: 'Jobs', stages: [{ id: 's-won', name: 'Job Awarded' }, { id: 's-new', name: 'New Lead' }] },
  { id: 'lab', name: 'Labor', stages: [{ id: 'l-open', name: 'Scheduled' }] },
  { id: 'F8i8hB7E5xHrJbJUXFr4', name: 'Containers', stages: [{ id: 'c-open', name: 'Delivered' }] },
  { id: 'Nvk3EKhRzg5omo4BLCOK', name: 'Change Orders', stages: [{ id: 'co-req', name: 'Customer Requested' }] },
] };
const rowsFor = {
  main: [
    { id: 'a', name: '1123 Main St', pipelineId: 'main', pipelineStageId: 's-won' },
    { id: 'b', name: '123 Main St', pipelineId: 'main', pipelineStageId: 's-won' },
    { id: 'c', name: '123 Main St Unit 2', pipelineId: 'main', pipelineStageId: 's-new' },
    { id: 'x', name: '123 Main St', pipelineId: 'other', pipelineStageId: 's-won' },
  ],
  lab: [{ id: 'l1', name: '123 Main St labor', pipelineId: 'lab', pipelineStageId: 'l-open', status: 'won' }],
  F8i8hB7E5xHrJbJUXFr4: [{ id: 'k1', name: '123 Main St 40 yard', pipelineId: 'F8i8hB7E5xHrJbJUXFr4', pipelineStageId: 'c-open', status: 'open' }],
  Nvk3EKhRzg5omo4BLCOK: [{ id: 'co1', name: 'Change Order #1 - 123 Main St', pipelineId: 'Nvk3EKhRzg5omo4BLCOK', pipelineStageId: 'co-req', status: 'open' }],
};
const search = u => ({ opportunities: rowsFor[u.searchParams.get('pipeline_id')] || [] });

test('job search covers demo, labor (by name), containers and change orders, and filters won jobs', async () => {
  const { calls, fetchImpl } = ghl({ '/opportunities/pipelines': pipelines, '/opportunities/search': search });
  const e = env();
  const worker = createWorker({ fetchImpl });
  const all = await call(worker, e, '/v1/jobs/search', { query: '123 Main', limit: 10 });
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.pipelines, ['demo', 'labor', 'containers', 'change_orders']);
  assert.deepEqual(new Set(all.data.jobs.map(j => j.pipeline)), new Set(['demo', 'labor', 'containers', 'change_orders']));
  assert.equal(all.data.jobs.find(j => j.id === 'l1').pipelineName, 'Labor');
  assert.equal(all.data.jobs.find(j => j.id === 'co1').stage, 'Customer Requested');
  assert.ok(!all.data.jobs.some(j => j.id === 'x'));
  const searched = calls.filter(c => c.path === '/opportunities/search').map(c => c.params.pipeline_id).sort();
  assert.deepEqual(searched, ['F8i8hB7E5xHrJbJUXFr4', 'Nvk3EKhRzg5omo4BLCOK', 'lab', 'main']);
  const won = await call(worker, e, '/v1/jobs/search', { query: '123 Main', won: true, pipelines: ['demo', 'labor', 'containers'] });
  assert.deepEqual(won.data.jobs.map(j => j.id), ['b', 'l1', 'a']);
  assert.equal((await call(worker, e, '/v1/jobs/search', { query: '123 Main', pipelines: ['nope'] })).status, 400);
  assert.equal(calls.filter(c => c.path === '/opportunities/pipelines').length, 1, 'pipelines are cached');
});

test('job search ranks the street number and caches in memory then KV', async () => {
  const { fetchImpl } = ghl({ '/opportunities/pipelines': pipelines, '/opportunities/search': search });
  const e = env();
  const worker = createWorker({ fetchImpl });
  const first = await call(worker, e, '/v1/jobs/search', { query: '123 Main', won: true, pipelines: ['demo'] });
  assert.deepEqual(first.data.jobs.map(j => j.id), ['b', 'a']);
  assert.equal(first.data.cache, 'miss');
  assert.equal((await call(worker, e, '/v1/jobs/search', { query: '123 main', won: true, pipelines: ['demo'] })).data.cache, 'memory');
  const coldIsolate = createWorker({ fetchImpl });
  assert.equal((await call(coldIsolate, e, '/v1/jobs/search', { query: '123 Main', won: true, pipelines: ['demo'] })).data.cache, 'kv');
  assert.equal((await call(worker, e, '/v1/jobs/search', { query: '123 Main', pipelines: ['demo'], fresh: true })).data.cache, 'miss');
  for (const key of e.CACHE.data.keys()) assert.match(key, /^v1:[a-f0-9]{64}$/);
});

test('cache entries expire on their own TTL even while KV still holds them', async () => {
  let clock = 0;
  const { calls, fetchImpl } = ghl({ '/conversations/search': { conversations: [{ id: 'conv', contactId: 'abc123', fullName: 'Sam' }] }, '/conversations/:id/messages': { messages: { messages: [] } } });
  const e = env();
  const worker = createWorker({ fetchImpl, now: () => clock });
  await call(worker, e, '/v1/texts', { contactId: 'abc123' });
  clock = 31000;
  assert.equal((await call(createWorker({ fetchImpl, now: () => clock }), e, '/v1/texts', { contactId: 'abc123' })).data.cache, 'miss');
  assert.equal(calls.filter(c => c.path === '/conversations/search').length, 2);
});

test('texts return SMS only with the conversations API version, and ask when a name matches several people', async () => {
  const { calls, fetchImpl } = ghl({
    '/conversations/search': u => u.searchParams.get('query') === 'Mike'
      ? { conversations: [{ id: '1', contactId: 'm1', fullName: 'Mike A' }, { id: '2', contactId: 'm2', fullName: 'Mike B' }] }
      : { conversations: [{ id: 'conv', contactId: 'abc123', fullName: 'Sam Lee' }] },
    '/conversations/:id/messages': { messages: { messages: [
      { body: 'Can you add the back wall?', direction: 'inbound', messageType: 'TYPE_SMS', dateAdded: '2026-11-24T18:00:00Z' },
      { body: 'call log', messageType: 'TYPE_CALL' },
      { body: 'Yes, sending a CO', direction: 'outbound', messageType: 'TYPE_SMS', dateAdded: '2026-11-24T17:00:00Z' },
    ] } },
  });
  const worker = createWorker({ fetchImpl });
  const r = await call(worker, env(), '/v1/texts', { query: 'Sam Lee', limit: 5 });
  assert.equal(r.data.contact.contactName, 'Sam Lee');
  assert.deepEqual(r.data.messages.map(m => m.direction), ['inbound', 'outbound']);
  assert.ok(calls.every(c => c.version === '2021-04-15'));
  const many = await call(worker, env(), '/v1/texts', { query: 'Mike' });
  assert.equal(many.data.matches.length, 2);
  assert.equal(many.data.messages, undefined);
});

test('unread lists SMS conversations only', async () => {
  const { fetchImpl } = ghl({ '/conversations/search': { conversations: [
    { contactId: 'a', fullName: 'Ana', lastMessageType: 'TYPE_SMS', lastMessageBody: 'Running late', unreadCount: 2 },
    { contactId: 'b', fullName: 'Bo', lastMessageType: 'TYPE_EMAIL', lastMessageBody: 'x', unreadCount: 1 },
  ] } });
  const r = await call(createWorker({ fetchImpl }), env(), '/v1/texts', { unread: true });
  assert.deepEqual(r.data.conversations.map(c => c.contactName), ['Ana']);
});

test('auth, config and input are enforced before any GHL call', async () => {
  const worker = createWorker({ fetchImpl: assert.fail });
  assert.equal((await call(worker, env(), '/v1/jobs/search', { query: '123 Main' }, 'wrong')).status, 401);
  assert.equal((await call(worker, env({ EDGE_KEY: '' }), '/v1/jobs/search', { query: '123 Main' }, '')).status, 401);
  assert.equal((await call(worker, env({ GHL_PIT_TOKEN: '' }), '/v1/jobs/search', { query: '123 Main' })).status, 503);
  assert.equal((await call(worker, env(), '/v1/jobs/search', { query: 'x' })).status, 400);
  assert.equal((await call(worker, env(), '/v1/texts', { contactId: '../x' })).status, 400);
  assert.equal((await call(worker, env(), '/v1/nope', {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://edge.example/health'), env())).status, 200);
});

test('score prefers the exact street number', () => {
  assert.ok(score('123 Main', '123 Main St') > score('123 Main', '1123 Main St'));
});
