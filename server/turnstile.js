// Single-use enforcement for Turnstile tokens (issue #72).
//
// The reservation is taken BEFORE the siteverify round-trip, so concurrent
// requests carrying the same token on one instance cannot both win the race.
// It is per-instance by design: Cloudflare's siteverify itself rejects a token
// that was already redeemed ("timeout-or-duplicate"), which covers replays that
// land on another Cloud Run instance, so a shared store only added Upstash
// commands. Extracted from server.js so the semantics are unit-testable
// (tests/turnstile.test.mjs).
import crypto from 'crypto';

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
}

export function createTurnstileReplayGuard() {
  const reserved = new Map(); // token fingerprint -> first-use timestamp

  // Returns { reserved: true } or { duplicate: true }.
  function reserve(token, now = Date.now()) {
    const key = fingerprint(token);
    if (reserved.has(key)) return { duplicate: true };
    reserved.set(key, now);
    return { reserved: true };
  }

  // Release only when the token did not verify or the transport threw — a
  // successfully verified token stays consumed until pruned.
  function release(token) {
    reserved.delete(fingerprint(token));
  }

  function size() {
    return reserved.size;
  }

  // Drops reservations older than maxAgeMs (server.js runs this periodically;
  // Turnstile tokens are only valid for 300 seconds).
  function prune(maxAgeMs, now = Date.now()) {
    for (const [key, timestamp] of reserved.entries()) {
      if (now - timestamp > maxAgeMs) reserved.delete(key);
    }
  }

  return { reserve, release, size, prune };
}
