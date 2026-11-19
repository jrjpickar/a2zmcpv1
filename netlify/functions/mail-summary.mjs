import { loadMailFilters } from './mail-filters.mjs';
import { dashboardAccess } from './lib/dashboard-auth.mjs';
import { json } from './lib/http.mjs';
import { mailSample, summarizePage } from './lib/mail.mjs';

export default async (request, { fetchImpl = fetch, openStore } = {}) => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  if (process.env.DATA_MODE === 'sample') return json(mailSample);
  const access = dashboardAccess(request);
  if (!access) {
    return json({ error: 'Dashboard key required' }, 401);
  }
  if (!access.mailbox) return json({ error: 'Mailbox access denied' }, 403);
  const token = process.env.MCP_MAIL_TOKEN?.trim();
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!token || !apiKey) return json({ error: 'Set MCP_MAIL_TOKEN and GROQ_API_KEY in Netlify Functions.' }, 503);
  let cursor;
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request too large' }, 413);
    ({ cursor } = JSON.parse(text || '{}'));
    if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 1000)) throw new Error();
  } catch {
    return json({ error: 'Invalid mailbox cursor' }, 400);
  }
  try {
    const filters = await loadMailFilters(openStore);
    const page = await summarizePage({ token, cursor, apiKey, model: process.env.GROQ_MODEL, fetchImpl, filters });
    return json({ status: 'ok', ...page });
  } catch (error) {
    if (error.retryAfter) return json({ error: 'Waiting for the mailbox or Groq rate limit.' }, 429, { 'Retry-After': String(error.retryAfter) });
    return json({ error: 'Could not summarize this mailbox page. Try again to resume.' }, 502);
  }
};
export const config = { path: '/api/mail-summary' };
