import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createOpportunity } from '../netlify/functions/lib/estimating-actions.mjs';
import { createHandler } from '../netlify/functions/jarvis-confirm.mjs';

const env = { DASHBOARD_KEY: 'dashboard-test-admin-key', ESTIMATING_URL: 'https://desk.example', ESTIMATING_ACTION_KEY: 'shared' };
const hash = 'a'.repeat(64);
const args = { address: '13281 Brookhurst St. Suite B', companyName: 'Acme', rebid: true };
const idempotencyKey = randomUUID();
const createRequest = (body, key = 'dashboard-test-admin-key', origin = 'https://operations.example') =>
  new Request('https://operations.example/api/jarvis/confirm', {
    method: 'POST', headers: { 'x-a2z-key': key, 'content-type': 'application/json', origin },
    body: JSON.stringify({ action: 'create_opportunity', args, ...body }),
  });

test('the Desk receives the unchanged opportunity args, hash, and idempotency key over HTTPS', async () => {
  const body = { dryRun: false, args, hash, idempotencyKey, actor: 'operator' };
  const result = await createOpportunity(body, { env, fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://desk.example/.netlify/functions/jarvis-actions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-jarvis-action-key'], 'shared');
    assert.deepEqual(JSON.parse(options.body), { ...body, action: 'create_opportunity' });
    return Response.json({ opportunityId: 'new' });
  } });
  assert.equal(result.data.opportunityId, 'new');
  for (const base of ['http://desk.example', 'https://user:pass@desk.example']) {
    assert.equal((await createOpportunity(body, { env: { ...env, ESTIMATING_URL: base }, fetchImpl: assert.fail })).status, 503);
  }
});

test('admin and same-origin checks and confirm validation prevent forwarding invalid requests', async () => {
  const handler = createHandler({ env, book: assert.fail });
  assert.equal((await handler(createRequest({ dryRun: true }, 'wrong'))).status, 401);
  assert.equal((await handler(createRequest({ dryRun: true }, 'dashboard-test-admin-key', 'https://other.example'))).status, 403);
  assert.equal((await handler(createRequest({ dryRun: false, hash: 'tampered', idempotencyKey }))).status, 400);
  assert.equal((await handler(createRequest({ dryRun: false, hash }))).status, 400);
});

test('preview requests cannot carry confirm credentials or spoof the actor', async () => {
  const handler = createHandler({ env, book: async body => {
    assert.deepEqual(body, { dryRun: true, args, actor: 'dashboard key' });
    return { status: 200, data: { preview: { outcome: 'new_opportunity', hash } } };
  } });
  const response = await handler(createRequest({ dryRun: true, actor: 'spoofed', hash, idempotencyKey }));
  assert.equal((await response.json()).preview.hash, hash);
});

for (const [label, status, data] of [
  ['different assignee or later page duplicate', 200, { preview: { outcome: 'duplicate', existing: { id: 'existing', assignedUserId: 'other' } } }],
  ['normalized address and new GC', 200, { preview: { outcome: 'multiple_gcs', pipelineId: 'multi', otherGcs: [{ id: 'primary' }] } }],
  ['rebid needs explicit approval', 409, { preview: { outcome: 'rebid_warning', canConfirm: false } }],
  ['matching opportunity appeared since preview', 409, { preview: { outcome: 'duplicate', existing: { id: 'newly-added' } } }],
  ['concurrent booking in progress', 409, { error: 'A booking for this project is already in progress.' }],
  ['multi-GC pipeline disabled', 409, { preview: { outcome: 'multiple_gcs', error: 'The multi-GC pipeline is not configured.' } }],
]) {
  test('Operations preserves the Desk result for ' + label, async () => {
    const handler = createHandler({ env, book: async () => ({ status, data }) });
    const response = await handler(createRequest({ dryRun: status === 200, hash, idempotencyKey }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), data);
  });
}
