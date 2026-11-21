import { dashboardAccess } from './lib/dashboard-auth.mjs';
import { json, readJson } from './lib/http.mjs';

import { commandCenterUrl, mailFeed } from './lib/mail-feed.mjs';
const counters = ['unreadIncoming', 'bidInvitations', 'urgentUnread', 'awaitingReply', 'unreadInvoiceMail'];
const sample = { unreadIncoming: 6, bidInvitations: 2, urgentUnread: 1, awaitingReply: 5, unreadInvoiceMail: 2 };

export default async request => {
  if (request.method !== 'GET') return json({ error: 'GET required' }, 405, { Allow: 'GET' });
  const queues = new URL(request.url).searchParams.get('view') === 'command-center';
  if (process.env.DATA_MODE === 'sample') {
    if (queues) return json({ status: 'ok', queues: {
      bids: [{ subject: 'Bid invitation: Harbor Plaza', from: 'Estimating', due: '2026-11-20' }],
      urgent: [], unanswered: [], invoices: [],
    }, recent: [] });
    return json({ status: 'ok', stats: sample, asOf: new Date().toISOString() });
  }
  const access = dashboardAccess(request);
  if (!access) {
    return json({ error: 'Dashboard key required' }, 401);
  }

  if (!access.mailbox) return json({ error: 'Mailbox access denied' }, 403);
  if (queues) {
    const token = process.env.MCP_MAIL_TOKEN?.trim();
    if (!token) return json({ error: 'Set MCP_MAIL_TOKEN in Netlify Functions to load Command Center queues.' }, 503);
    try { return json({ status: 'ok', ...await mailFeed('command-center', { token }) }); }
    catch { return json({ error: 'Command Center queues are unavailable.' }, 502); }
  }
  const token = process.env.MCP_COMMAND_CENTER_TOKEN?.trim();
  if (!token) return json({ status: 'setup' });
  try {
    const { stats, asOf, arrivalSequence } = await readJson(commandCenterUrl, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(9000),
    });
    if (!counters.every(field => Number.isSafeInteger(stats?.[field]) && stats[field] >= 0) ||
        typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) {
      return json({ status: 'unavailable' }, 502);
    }
    return json({ status: 'ok', stats: Object.fromEntries(counters.map(field => [field, stats[field]])), asOf,
      arrivalSequence: Number.isSafeInteger(arrivalSequence) && arrivalSequence >= 0 ? arrivalSequence : null });
  } catch {
    return json({ status: 'unavailable' }, 502);
  }
};
export const config = { path: '/api/mail' };
