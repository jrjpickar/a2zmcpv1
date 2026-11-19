export const commandCenterUrl = 'https://a2zemails.netlify.app/api/mcp/command-center';

const base = new URL('/api/mcp/mail/', commandCenterUrl);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function mailFeed(action, { token, query, draft, fetchImpl = fetch }) {
  const url = new URL(action, base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json',
      ...(draft ? { 'Content-Type': 'application/json' } : {}) },
    method: draft ? 'POST' : 'GET',
    body: draft ? JSON.stringify(draft) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(9000),
  });
  if (response.status === 429) {
    const delay = Number(response.headers.get('retry-after')) || 60;
    throw Object.assign(new Error('Mailbox rate limit'), { retryAfter: Math.min(120, Math.max(5, delay)) });
  }
  if (!response.ok) {
    const safeMessages = {
      400: 'The mailbox rejected the request. Check the fields or the saved draft limit.',
      404: 'The message or folder is no longer available.',
      409: 'The mailbox or draft changed. Refresh before retrying.',
    };
    throw Object.assign(new Error(safeMessages[response.status] || 'The mailbox feed is unavailable.'), { mailError: true });
  }
  return response.json();
}

export async function inboxPage({ token, cursor, fetchImpl, includeHeaders = false }) {
  let query = {};
  if (cursor != null) {
    const match = /^(\d{1,20}):([1-9]\d{0,9})$/.exec(cursor);
    if (!match || Number(match[2]) > 4294967296) throw new Error('Invalid mailbox cursor');
    query = { uidValidity: match[1], before: match[2] };
  }
  const page = await mailFeed('messages', {
    token, fetchImpl, query: { ...query, folder: 'INBOX', view: 'full', limit: 5 },
  });
  if (!Array.isArray(page.messages) || page.messages.length > 5) throw new Error('Invalid mailbox page');
  const nextCursor = page.hasMore ? page.uidValidity + ':' + page.next : null;
  if (nextCursor && (nextCursor === cursor || !/^\d{1,20}:[1-9]\d{0,9}$/.test(nextCursor))) {
    throw new Error('Invalid mailbox cursor');
  }
  const messages = await Promise.all(page.messages.map(async ({ id }) => {
    const { subject, body, date, from, headers } = await mailFeed('message', { token, fetchImpl, query: { id, ...(includeHeaders ? { headers: 1 } : {}) } });
    if (typeof id !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
      throw new Error('Invalid mailbox message');
    }
    return { id, subject, text: body, receivedAt: date, from, headers };
  }));
  return { messages, nextCursor };
}

export function draftInput(args) {
  const limits = { to: 2048, cc: 2048, bcc: 2048, subject: 500, body: 10000 };
  const draft = {};
  for (const [key, limit] of Object.entries(limits)) {
    const value = args[key] ?? '';
    if (typeof value !== 'string' || value.length > limit || (key !== 'body' && /[\r\n\x00]/.test(value))) {
      throw new TypeError('Invalid draft ' + key + '.');
    }
    draft[key] = value;
  }
  if (!uuid.test(args.id ?? '')) throw new TypeError('Provide a UUID for the draft ID.');
  if (!draft.body.trim()) throw new TypeError('Provide the draft body.');
  return { ...draft, id: args.id.toLowerCase() };
}
