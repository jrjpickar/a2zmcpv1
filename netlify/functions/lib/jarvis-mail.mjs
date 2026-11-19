// Mailbox snapshot for the JARVIS Email agent. Reads the A2Z email app's command-center endpoint
// (the same one the Mail district uses) and keeps a short snapshot in JARVIS storage. No Groq calls here.
// The optional JARVIS_EMAIL_URL overrides the counters endpoint only.
import { commandCenterUrl, inboxPage } from './mail-feed.mjs';

export const MAIL_KEY = 'mail/snapshot';
const maxAgeMs = 15 * 60000;
const fail = (message, agentStatus) => Object.assign(new Error(message), { agentStatus });

function excerpt(text, bytes) {
  const value = Buffer.from(String(text).slice(0, 4000), 'utf8');
  return value.length <= bytes ? value.toString() : value.subarray(0, bytes).toString().replace(/�$/, '');
}

export function mailSettings(env = process.env) {
  const token = env.MCP_COMMAND_CENTER_TOKEN?.trim();
  let url = commandCenterUrl;
  if (env.JARVIS_EMAIL_URL?.trim()) {
    const custom = URL.parse(env.JARVIS_EMAIL_URL.trim());
    if (!custom || custom.protocol !== 'https:' || custom.username || custom.password) throw fail('JARVIS_EMAIL_URL must be an HTTPS URL.', 503);
    url = custom.href;
  }
  const pages = Math.min(4, Math.max(1, Number.parseInt(env.JARVIS_EMAIL_PAGES, 10) || 2));
  const mailToken = env.MCP_MAIL_TOKEN?.trim();
  return { token, mailToken, url, pages, enabled: Boolean(token && mailToken) && env.JARVIS_EMAIL_SYNC !== 'off' };
}

export const sampleMailbox = () => ({
  source: 'sample', syncedAt: new Date().toISOString(), asOf: new Date().toISOString(),
  stats: { unreadIncoming: 6, bidInvitations: 2, urgentUnread: 1, awaitingReply: 5, unreadInvoiceMail: 2 },
  messages: [
    { subject: 'Bid invitation: Harbor Plaza phase 2 interior demo', receivedAt: new Date(Date.now() - 3600e3).toISOString(), text: 'Scope review requested by Friday 3 PM. Walkthrough Thursday 9 AM.' },
    { subject: 'Crew confirmation for Thursday', receivedAt: new Date(Date.now() - 7200e3).toISOString(), text: 'Please confirm six workers and share the 6:30 AM check-in location.' },
    { subject: 'Supplier invoice 4471', receivedAt: new Date(Date.now() - 86400e3).toISOString(), text: 'Invoice for roll off hauling. Match to the purchase order before approval.' },
  ],
  messagesAvailable: true,
});

export async function fetchMailbox({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.DATA_MODE === 'sample') return sampleMailbox();
  const { token, mailToken, url, pages } = mailSettings(env);
  if (!token) throw fail('Set MCP_COMMAND_CENTER_TOKEN so the Email agent can read the mailbox.', 503);
  const get = async target => {
    const response = await fetchImpl(target, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail('The email app is unavailable (HTTP ' + response.status + ').', 502); }
    return response.json();
  };
  const { stats = null, asOf = null } = await get(url);
  const messages = [];
  let cursor = null, messagesAvailable = false;
  for (let page = 0; mailToken && page < pages; page++) {
    let data;
    try { data = await inboxPage({ token: mailToken, cursor, fetchImpl }); } catch (error) {
      if (page === 0) throw error;
      break;
    }
    messagesAvailable = true;
    for (const message of data.messages.slice(0, 5)) {
      if (typeof message?.subject !== 'string' || typeof message.text !== 'string') continue;
      messages.push({
        subject: excerpt(message.subject, 200),
        ...(typeof message.from === 'string' ? { from: excerpt(message.from, 120) } : {}),
        receivedAt: typeof message.receivedAt === 'string' ? message.receivedAt.slice(0, 40) : null,
        text: excerpt(message.text, 700),
      });
    }
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  return { source: 'email-app', syncedAt: new Date().toISOString(), asOf: typeof asOf === 'string' ? asOf : null, stats, messages, messagesAvailable };
}

export async function syncMailbox({ env = process.env, fetchImpl = fetch, store }) {
  const snapshot = await fetchMailbox({ env, fetchImpl });
  await store.setJSON(MAIL_KEY, snapshot, {});
  return snapshot;
}

// Fresh snapshot for the Email agent: stored copy when under 15 minutes old, otherwise a live read.
// A stale copy is used (and flagged) when the live read fails.
export async function mailboxContext({ env = process.env, fetchImpl = fetch, store = null } = {}) {
  if (env.DATA_MODE === 'sample') return sampleMailbox();
  const stored = store ? await store.getWithMetadata(MAIL_KEY, { type: 'json' }).then(entry => entry?.data, () => null) : null;
  if (stored && Date.now() - Date.parse(stored.syncedAt) < maxAgeMs) return stored;
  try {
    const snapshot = await fetchMailbox({ env, fetchImpl });
    if (store) await store.setJSON(MAIL_KEY, snapshot, {}).catch(() => {});
    return snapshot;
  } catch (error) {
    if (stored) return { ...stored, stale: true };
    throw error;
  }
}
