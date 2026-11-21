import { guard, readBody } from './lib/jarvis-http.mjs';
import { json } from './lib/http.mjs';
import { action } from './lib/actions.mjs';

export function createHandler({ env = process.env, book = body => action('a2z_create_opportunity').run(body, { env }) } = {}) {
  return async function handler(request) {
    const { access, response } = guard(request, { env });
    if (response) return response;
    let body;
    try {
      body = await readBody(request, 16384);
      if (body.action !== 'create_opportunity' || typeof body.dryRun !== 'boolean' ||
        !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new Error();
      if (!body.dryRun && (typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash) ||
        typeof body.idempotencyKey !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.idempotencyKey))) throw new Error();
    } catch (error) {
      return json({ error: 'Invalid opportunity request.' }, error.status === 413 ? 413 : 400);
    }
    const { status, data } = await book({
      dryRun: body.dryRun, args: body.args, actor: access.userId || 'dashboard key',
      ...(body.dryRun ? {} : { hash: body.hash, idempotencyKey: body.idempotencyKey }),
    });
    return json(data, status);
  };
}

export default createHandler();
export const config = { path: '/api/jarvis/confirm' };
