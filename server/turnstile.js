// Atomic single-use enforcement for Turnstile tokens (issue #72).
//
// The reservation is a Redis INCRBY issued BEFORE the siteverify round-trip:
// concurrent requests carrying the same token cannot both win the race, and
// the reservation lives in Redis, so it is shared across Cloud Run instances
// (the previous in-memory Map was neither). Extracted from server.js so the
// semantics are unit-testable (tests/turnstile.test.mjs).
import crypto from 'crypto';

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

// incrementCounter(key, ttlSeconds, delta?) must be atomic (Redis INCRBY) and
// return { count } or null when the store is unavailable. redisEnabled() tells
// the guard whether the shared store is in play; without it the guard degrades
// to a per-instance Map, which callers must only allow outside production.
export function createTurnstileReplayGuard({
  incrementCounter,
  redisEnabled = () => false,
  ttlSeconds = 60 * 60,
  keyPrefix = 'ts:used'
} = {}) {
  const memory = new Map(); // token -> first-use timestamp (no-Redis fallback)

  function keyFor(token) {
    return `${keyPrefix}:${fingerprint(token)}`;
  }

  // Returns { reserved: true }, { duplicate: true }, or { unavailable: true }.
  async function reserve(token) {
    if (redisEnabled()) {
      const reservation = await incrementCounter(keyFor(token), ttlSeconds, 1);
      if (!reservation) return { unavailable: true };
      return { reserved: reservation.count === 1, duplicate: reservation.count > 1 };
    }
    if (memory.has(token)) return { duplicate: true };
    memory.set(token, Date.now());
    return { reserved: true };
  }

  // Release only when the token did not verify or the transport threw — a
  // successfully verified token stays consumed for the TTL window.
  async function release(token) {
    if (redisEnabled()) {
      await incrementCounter(keyFor(token), ttlSeconds, -1);
      return;
    }
    memory.delete(token);
  }

  function memorySize() {
    return memory.size;
  }

  // Drops fallback-map entries older than maxAgeMs (used by server.js's
  // periodic sweep; Redis reservations expire via TTL on their own).
  function prune(maxAgeMs, now = Date.now()) {
    for (const [token, timestamp] of memory.entries()) {
      if (now - timestamp > maxAgeMs) memory.delete(token);
    }
  }

  return { reserve, release, memorySize, prune };
}
