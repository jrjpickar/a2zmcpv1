import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { authorized } from './http.mjs';

const lifetimeSeconds = 900;
const list = value => (value || '').split(',').map(item => item.trim()).filter(Boolean);

export function marketplaceIdentity(user, env) {
  if (!env.GHL_APP_SHARED_SECRET || !env.GHL_SESSION_SECRET || env.GHL_SESSION_SECRET.length < 32 ||
      !env.GHL_MARKETPLACE_COMPANY_ID || !env.GHL_LOCATION_ID || typeof user?.userId !== 'string' ||
      user.companyId !== env.GHL_MARKETPLACE_COMPANY_ID || user.activeLocation !== env.GHL_LOCATION_ID ||
      !list(env.GHL_MARKETPLACE_ALLOWED_USERS).includes(user.userId)) return null;
  return {
    userId: user.userId,
    companyId: user.companyId,
    activeLocation: user.activeLocation,
    mailbox: list(env.GHL_MARKETPLACE_MAIL_USERS).includes(user.userId),
    admin: list(env.GHL_MARKETPLACE_ADMIN_USERS).includes(user.userId),
  };
}

// HighLevel Custom Pages send the CryptoJS passphrase format (OpenSSL salted AES-256-CBC).
export function decryptHighLevelContext(encrypted, secret) {
  const bytes = Buffer.from(encrypted, 'base64');
  if (bytes.length < 32 || bytes.length % 16 || bytes.subarray(0, 8).toString() !== 'Salted__') {
    throw new Error('Invalid HighLevel context');
  }
  const salt = bytes.subarray(8, 16);
  const password = Buffer.from(secret, 'utf8');
  const blocks = [];
  for (let previous = Buffer.alloc(0); blocks.length < 3;) {
    previous = createHash('md5').update(previous).update(password).update(salt).digest();
    blocks.push(previous);
  }
  const decipher = createDecipheriv('aes-256-cbc', Buffer.concat(blocks.slice(0, 2)), blocks[2]);
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update('a2z-ghl-session-v1.' + payload).digest();
}

export function createMarketplaceSession(identity, env, now = Date.now()) {
  const expires = Math.floor(now / 1000) + lifetimeSeconds;
  const { userId, companyId, activeLocation } = identity;
  const payload = Buffer.from(JSON.stringify({ userId, companyId, activeLocation, expires })).toString('base64url');
  return { token: payload + '.' + sign(payload, env.GHL_SESSION_SECRET).toString('base64url'), expires };
}

export function marketplaceSession(request, env = process.env, now = Date.now()) {
  const token = request.headers.get('x-a2z-session');
  if (!token || token.length > 2048 || !env.GHL_SESSION_SECRET || env.GHL_SESSION_SECRET.length < 32) return null;
  const match = /^([\w-]+)\.([\w-]{43})$/.exec(token);
  if (!match) return null;
  const [, payload, signature] = match;
  const supplied = Buffer.from(signature, 'base64url');
  if (!timingSafeEqual(supplied, sign(payload, env.GHL_SESSION_SECRET))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(user.expires) || user.expires <= Math.floor(now / 1000)) return null;
    return marketplaceIdentity(user, env);
  } catch {
    return null;
  }
}

export function dashboardAccess(request, env = process.env) {
  if (request.headers.has('x-a2z-session')) return marketplaceSession(request, env);
  return authorized(request, env.DASHBOARD_KEY, 'x-a2z-key') ? { admin: true, mailbox: true } : null;
}


// A standalone dashboard credential represents one configured Desk operator.
// Keep this mapping server-side and separate from Marketplace identity.
export function deskActor(access, env) {
  if (access?.userId) return access.userId;
  const userId = env.ESTIMATING_DASHBOARD_USER_ID?.trim();
  return access?.admin && /^[\w-]{1,100}$/.test(userId || '') ? userId : null;
}
