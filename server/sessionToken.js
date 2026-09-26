// Stateless signed tokens: session cookies and WinDBG file handles.
//
// Anything a follow-up request must trust travels with the client instead of
// living in a shared store, so any Cloud Run instance can verify it with no
// Redis round-trip. Each purpose signs with its own HKDF-derived key from
// SESSION_SECRET (a token minted for one purpose never verifies as another);
// SESSION_SECRET_PREVIOUS verifies but never signs, so the secret can rotate
// without logging everyone out at once.
import crypto from 'node:crypto';

// Largest legitimate token is a session carrying the forum identity (~1.1 KB:
// avatar URL <= 400 chars, username <= 80). Oversized input is rejected before
// any HMAC work.
const MAX_TOKEN_LENGTH = 2048;
const MAC_BYTES = 32;
const CLOCK_SKEW_MS = 60 * 1000;
const SESSION_ID_RE = /^[a-f0-9]{64}$/;
const FORUM_IDENTITY_FIELDS = ['tier', 'wfUserId', 'wfUsername', 'wfAvatar', 'wfVerifiedAt', 'tierExpiresAt'];

export function deriveKey(secret, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', String(secret), '', `bsod-analyzer:${purpose}`, 32));
}

export function createSigner({ secret, previousSecret, purpose }) {
  if (!secret) throw new TypeError('createSigner requires a secret');
  if (!purpose) throw new TypeError('createSigner requires a purpose');
  const keys = [secret, previousSecret].filter(Boolean).map(value => deriveKey(value, purpose));
  const mac = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest();

  return {
    sign(claims) {
      const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      return `${payload}.${mac(keys[0], payload).toString('base64url')}`;
    },

    // Returns the claims object, or null for anything malformed or unsigned.
    verify(token) {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
      const dot = token.indexOf('.');
      if (dot < 1 || dot !== token.lastIndexOf('.')) return null;
      const payload = token.slice(0, dot);
      const provided = Buffer.from(token.slice(dot + 1), 'base64url');
      if (provided.length !== MAC_BYTES) return null;
      if (!keys.some(key => crypto.timingSafeEqual(provided, mac(key, payload)))) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
      } catch {
        return null;
      }
    }
  };
}

// Session cookie: { v, sid, createdAt, timestamp, turnstileVerified, ...forum identity }.
// `timestamp` is the last issue time (idle expiry); `createdAt` anchors the
// absolute lifetime. Callers re-issue to slide the idle window.
export function createSessionCodec({ secret, previousSecret, idleMs, maxAgeMs }) {
  const signer = createSigner({ secret, previousSecret, purpose: 'session-v2' });

  return {
    issue(sessionId, sessionData) {
      const claims = {
        v: 2,
        sid: sessionId,
        createdAt: sessionData.createdAt,
        timestamp: sessionData.timestamp,
        turnstileVerified: sessionData.turnstileVerified === true
      };
      for (const field of FORUM_IDENTITY_FIELDS) {
        if (sessionData[field] !== undefined) claims[field] = sessionData[field];
      }
      return signer.sign(claims);
    },

    verify(token, now = Date.now()) {
      const claims = signer.verify(token);
      if (!claims || claims.v !== 2 || typeof claims.sid !== 'string' || !SESSION_ID_RE.test(claims.sid)) {
        return { valid: false, reason: 'Invalid session' };
      }
      const { createdAt, timestamp } = claims;
      if (
        !Number.isFinite(createdAt) ||
        !Number.isFinite(timestamp) ||
        createdAt > timestamp ||
        timestamp > now + CLOCK_SKEW_MS
      ) {
        return { valid: false, reason: 'Invalid session' };
      }
      if (now - timestamp > idleMs || now - createdAt > maxAgeMs) {
        return { valid: false, reason: 'Session expired' };
      }
      const { v: _version, sid, ...sessionData } = claims;
      return { valid: true, sessionId: sid, sessionData };
    }
  };
}

// Binds a handle to a session without putting the session id itself in a
// value the page can read.
export function sessionTag(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId)).digest('base64url').slice(0, 22);
}

// WinDBG file handle: proof that this session uploaded the file with hash
// `fh`, plus the upstream WinDBG job id (`jid`) and dump type (`dt`) when a job
// was submitted, so status/download/cache reads work on an instance that
// never saw the upload.
export function createFileHandleCodec({ secret, previousSecret, ttlMs }) {
  const signer = createSigner({ secret, previousSecret, purpose: 'windbg-handle-v1' });

  return {
    issue({ fileHash, jobId = null, dumpType = null, sessionId }, now = Date.now()) {
      const claims = { v: 1, fh: fileHash, st: sessionTag(sessionId), exp: now + ttlMs };
      if (jobId) claims.jid = String(jobId);
      if (dumpType) claims.dt = String(dumpType);
      return signer.sign(claims);
    },

    // Returns the claims when the handle proves `sessionId` uploaded `fileHash`.
    verify(handle, { fileHash, sessionId }, now = Date.now()) {
      const claims = signer.verify(handle);
      if (!claims || claims.v !== 1) return null;
      if (claims.fh !== fileHash || claims.st !== sessionTag(sessionId)) return null;
      if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;
      return claims;
    }
  };
}
