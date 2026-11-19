import assert from 'node:assert/strict';
import test from 'node:test';
import signIn from '../netlify/functions/highlevel-session.mjs';
import install from '../netlify/functions/highlevel-install.mjs';
import mail from '../netlify/functions/mail.mjs';
import mailSummary from '../netlify/functions/mail-summary.mjs';
import { marketplaceSession } from '../netlify/functions/lib/dashboard-auth.mjs';
import { summarizePage } from '../netlify/functions/lib/mail.mjs';

const origin = 'https://ops.example';
const activeLocation = 'a2z-location';
const companyId = 'a2z-company';
// OpenSSL AES-256-CBC with the fixture passphrase and legacy MD5 derivation used by CryptoJS.
const encrypted = {
  "staff": "U2FsdGVkX19FDLyfeh8Ni6yRWeocUX+UbVzcgkQnSR9zMU9RBvYZ3RXSOSljZcSfqjNnK48ohUONolfNe602WHU37YjL4tBfyW6L+nF0Isf5qGBIfKn/DOFI6+Uo9bBEs3zHeVySBeR2kEvP+HE2IAT4Uca9XnebIBbwNTPpUM38R7j0f/Z4h7cYTD/afT4y",
  "wrongLocation": "U2FsdGVkX1+42YlZDSUk03uSH24Ky8/MUfBHpJyhXEZTGafxdQCzi/vKyRGpO+eJQrgtwcB5ZkuynfU3KKGMi2/jd/MhGTG0PzeypiTByUMWoaukmBFjvGJWDtfeM8It/nxlhzKgxwlbT2NSCtdyUFCWXz6Qdm93JcqBw+1cGc0=",
  "unknown": "U2FsdGVkX19z1zNjwaf1lPAV33rL5VKicJVDLM30zxUTB/gOC1+iIhSB5a+OlVMeS82p/JcXcEeBmzxYRiNhrcUME21Q+TISJV/bg/45f3qSaPw/79qjyMMTKk+6cRxG8c6d2iD+PIM9qmITi+kYkjzowVSj4zpD8LJe8gTXpxEvSzH2qLhC0cHTJ2t8ndWD",
  "mailboxUser": "U2FsdGVkX19gMy9NgcK+lNopvZqBVJntmK6/3lIfp48cLbt7doFST3MCcXR0/BI4yb0bgVRSR9YcpyjRB4FmwcKqQJy6QoVVIhmkXJKW5iPsB5xgJxqXeyk1X3sj4fXuRpPaG23QBm/rIXBYXWRRjqbj/71Dk71SODjFObV/PjCH7ORFpQFlgikIWpOxrvah"
};

function configure() {
  Object.assign(process.env, {
    DATA_MODE: 'live',
    GHL_APP_SHARED_SECRET: 'a-highlevel-test-shared-secret',
    GHL_SESSION_SECRET: 'a-standalone-test-session-signing-secret',
    GHL_MARKETPLACE_COMPANY_ID: companyId,
    GHL_LOCATION_ID: activeLocation,
    GHL_MARKETPLACE_ALLOWED_USERS: 'staff, mailbox-user',
    GHL_MARKETPLACE_MAIL_USERS: 'mailbox-user',
    GHL_MARKETPLACE_CLIENT_ID: 'test-client-id',
    GHL_MARKETPLACE_CLIENT_SECRET: 'test-client-secret',
    MCP_COMMAND_CENTER_TOKEN: 'test-mail-token',
    GROQ_API_KEY: 'test-groq-key',
  });
}

const contextRequest = (fixture, requestOrigin = origin) => new Request(origin + '/api/highlevel/session', {
  method: 'POST', headers: { Origin: requestOrigin }, body: JSON.stringify({ encryptedData: encrypted[fixture] }),
});
const dashboardRequest = (token, path = '/api/mail', method = 'GET') => new Request(origin + path, {
  method, headers: { 'x-a2z-session': token },
});

test('HighLevel sessions enforce tenant, user, expiration, signature and mailbox permissions', async () => {
  configure();
  assert.equal((await signIn(contextRequest('staff', 'https://other.example'))).status, 403);
  assert.equal((await signIn(contextRequest('wrongLocation'))).status, 403);
  assert.equal((await signIn(contextRequest('unknown'))).status, 403);
  const response = await signIn(contextRequest('staff'));
  assert.equal(response.status, 200);
  const { token, expires } = await response.json();
  assert.equal(marketplaceSession(dashboardRequest(token)).mailbox, false);
  assert.equal(marketplaceSession(dashboardRequest(token), process.env, expires * 1000), null);
  const [payload, signature] = token.split('.');
  const tampered = payload + '.' + (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  assert.equal(marketplaceSession(dashboardRequest(tampered)), null);
  assert.equal((await mail(dashboardRequest(token))).status, 403);
  assert.equal((await mailSummary(dashboardRequest(token, '/api/mail-summary', 'POST'))).status, 403);
  const other = await signIn(contextRequest('mailboxUser')).then(r => r.json());
  assert.equal(marketplaceSession(dashboardRequest(other.token)).mailbox, true);
  process.env.GHL_MARKETPLACE_ALLOWED_USERS = 'staff';
  assert.equal(marketplaceSession(dashboardRequest(other.token)), null);
});

test('Marketplace OAuth installs only the configured location and consumes callback state once', async () => {
  configure();
  const target = origin + '/api/highlevel/install';
  process.env.GHL_MARKETPLACE_INSTALL_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation?redirect_uri=' + encodeURIComponent(target);
  const start = await install(new Request(target));
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const callback = target + '?code=mock-code&state=' + state;
  assert.equal((await install(new Request(callback))).status, 400);
  const states = new Set();
  const store = { async setJSON(key, data, options) {
    assert.equal(options.onlyIfNew, true);
    if (states.has(key)) return { modified: false };
    states.add(key);
    return { modified: true };
  } };
  let exchanges = 0;
  const fetchImpl = async (url, init) => {
    exchanges++;
    assert.equal(url, 'https://services.leadconnectorhq.com/oauth/token');
    assert.equal(init.body.get('user_type'), 'Location');
    assert.equal(init.body.get('code'), 'mock-code');
    assert.equal(init.body.get('redirect_uri'), target);
    return Response.json({ access_token: 'private-token', companyId, locationId: activeLocation });
  };
  const request = () => new Request(callback, { headers: { Cookie: cookie } });
  const result = await install(request(), { store, fetchImpl });
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), /private-token/);
  assert.equal((await install(request(), { store, fetchImpl })).status, 400);
  assert.equal(exchanges, 1);
});

test('Groq summaries keep the mailbox page bounded and handle retries without losing the cursor', async () => {
  let completions = 0;
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/mcp/mail/messages') {
      assert.equal(init.headers.Authorization, 'Bearer fixture');
      assert.equal(searchParams.get('uidValidity'), '42');
      assert.equal(searchParams.get('before'), '10');
      assert.equal(searchParams.get('limit'), '5');
      return Response.json({ messages: [{ id: 'INBOX:42:9' }], uidValidity: '42', hasMore: true, next: 9 });
    }
    if (pathname === '/api/mcp/mail/message') {
      assert.equal(searchParams.get('id'), 'INBOX:42:9');
      return Response.json({ subject: 'Crew call', body: '⚙'.repeat(4000) });
    }
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, 'openai/gpt-oss-120b');
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.include_reasoning, false);
    assert.ok(Buffer.byteLength(JSON.parse(payload.messages[1].content)[0].text) <= 2000);
    if (++completions === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '9' } });
    if (completions === 2) return Response.json({ choices: [{ finish_reason: 'length', message: { content: 'Incomplete' } }] });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Confirm crew availability.' } }] });
  };
  const run = () => summarizePage({ token: 'fixture', apiKey: 'key', cursor: '42:10', fetchImpl });
  await assert.rejects(run, error => error.retryAfter === 9);
  await assert.rejects(run, /Incomplete summary/);
  const result = await run();
  assert.deepEqual(result, { summarized: 1, summary: 'Confirm crew availability.', nextCursor: '42:9' });
  assert.deepEqual(await run(), result);
  assert.equal(completions, 3);
});
