// Cross-instance counters for the per-key abuse controls (issue #134): the
// per-session / per-tier AI quota and the cost-bearing per-key limiters.
//
// Sessions are stateless and valid on every Cloud Run instance, and session
// affinity is best effort: a client that drops the affinity cookie, or keeps
// more requests in flight than --concurrency, is spread over other instances.
// Per-instance counters therefore admit up to max-instances times a per-key
// limit. These counters live in a dedicated Upstash database
// (QUOTA_REDIS_REST_URL / QUOTA_REDIS_REST_TOKEN) instead, at one EVAL per
// check. It is separate from the optional analysis cache: redis.cfg does not
// switch it, and enabling it does not turn the analysis cache back on.
//
// The store is never required for availability (2026-09 outage): when it is
// not configured, or a call fails or stalls, the caller's per-instance
// counters answer and the store is skipped for a cool-down. An outage
// degrades enforcement to per-instance; it never fails a request.
import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { createMemoryRateLimitStore } from './rateLimit.js';
import { createSessionQuotaStore } from './quotaStore.js';

const KEY_PREFIX = 'rt:';
const DEFAULT_CALL_TIMEOUT_MS = 1500;
const DEFAULT_COOLDOWN_MS = 30 * 1000;

// Checks both caps before moving either counter, like the per-instance store.
export const QUOTA_RESERVE_SCRIPT = `
local cur_req = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_tok = tonumber(redis.call('GET', KEYS[2]) or '0')
local add_req = tonumber(ARGV[1])
local add_tok = tonumber(ARGV[2])
local ttl = tonumber(ARGV[5])
if cur_req + add_req > tonumber(ARGV[3]) then return {0, 1, cur_req, cur_tok, redis.call('TTL', KEYS[1])} end
if cur_tok + add_tok > tonumber(ARGV[4]) then return {0, 2, cur_req, cur_tok, redis.call('TTL', KEYS[2])} end
redis.call('INCRBY', KEYS[1], add_req)
redis.call('INCRBY', KEYS[2], add_tok)
if redis.call('TTL', KEYS[1]) < 1 then redis.call('EXPIRE', KEYS[1], ttl) end
if redis.call('TTL', KEYS[2]) < 1 then redis.call('EXPIRE', KEYS[2], ttl) end
return {1, 0, cur_req + add_req, cur_tok + add_tok, redis.call('TTL', KEYS[1])}
`;

// Moves live counters by a signed delta, floored at zero. A counter whose
// window already expired is left alone rather than reopened.
export const QUOTA_ADJUST_SCRIPT = `
for i = 1, 2 do
  local delta = tonumber(ARGV[i])
  if delta ~= 0 and redis.call('EXISTS', KEYS[i]) == 1 then
    local cur = tonumber(redis.call('GET', KEYS[i]) or '0')
    redis.call('INCRBY', KEYS[i], math.max(-cur, delta))
  end
end
return 1
`;

// Releases a reservation after a failure that was not the client's fault;
// capped per window so failures cannot be farmed to shift accounting back.
export const QUOTA_REFUND_SCRIPT = `
local refunded = tonumber(redis.call('GET', KEYS[3]) or '0')
if refunded >= tonumber(ARGV[3]) then return {0, refunded} end
redis.call('INCRBY', KEYS[3], 1)
local cur_req = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_tok = tonumber(redis.call('GET', KEYS[2]) or '0')
if cur_req > 0 then redis.call('INCRBY', KEYS[1], -math.min(cur_req, tonumber(ARGV[1]))) end
if cur_tok > 0 then redis.call('INCRBY', KEYS[2], -math.min(cur_tok, tonumber(ARGV[2]))) end
for i = 1, 3 do if redis.call('TTL', KEYS[i]) < 1 then redis.call('EXPIRE', KEYS[i], ARGV[4]) end end
return {1, refunded + 1}
`;

// Fixed-window hit counter: the first hit opens the window.
export const RATE_LIMIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

// Keys are hashed: counters never store a raw IP, session id or API key, and
// their length stays bounded whatever the caller passes.
function counterId(key) {
  return crypto.createHash('sha256').update(String(key)).digest('base64url').slice(0, 32);
}

function quotaKeys(key) {
  const id = counterId(key);
  return [`${KEY_PREFIX}q:req:${id}`, `${KEY_PREFIX}q:tok:${id}`, `${KEY_PREFIX}q:ref:${id}`];
}

const whole = value => String(Math.max(0, Math.ceil(Number(value) || 0)));
const signed = value => String(Math.trunc(Number(value) || 0));

// `client` needs only eval(script, keys, args). Returns null for every call
// while unconfigured, failing or cooling down, so callers fall back locally.
export function createSharedCounterStore({
  client = null,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  onError = () => {}
} = {}) {
  let skipUntil = 0;

  async function run(script, keys, args) {
    if (!client || now() < skipUntil) return null;
    let timer;
    try {
      const stalled = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`shared counter call exceeded ${timeoutMs}ms`)), timeoutMs);
      });
      // Redis EVAL of the constant Lua scripts above (atomic server-side
      // check-and-increment); nothing caller-supplied is ever a script.
      const result = await Promise.race([client.eval(script, keys, args), stalled]);
      if (!Array.isArray(result) && typeof result !== 'number') throw new Error('unexpected shared counter reply');
      return result;
    } catch (error) {
      skipUntil = now() + cooldownMs;
      onError(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function reserveQuota(key, { requestCost = 1, tokenCost, requestLimit, tokenLimit, windowSeconds }) {
    const [reqKey, tokKey] = quotaKeys(key);
    const raw = await run(QUOTA_RESERVE_SCRIPT, [reqKey, tokKey], [
      whole(requestCost), whole(tokenCost), whole(requestLimit), whole(tokenLimit), String(Math.max(1, Math.ceil(windowSeconds)))
    ]);
    if (!raw) return null;
    const [allowed, reason, requests, tokens, ttl] = raw.map(Number);
    return {
      allowed: allowed === 1,
      reason: allowed === 1 ? undefined : (reason === 1 ? 'requests' : 'tokens'),
      requests,
      tokens,
      resetTime: new Date(now() + (ttl > 0 ? ttl : windowSeconds) * 1000)
    };
  }

  async function adjustQuota(key, { requestDelta = 0, tokenDelta = 0 }) {
    const [reqKey, tokKey] = quotaKeys(key);
    return (await run(QUOTA_ADJUST_SCRIPT, [reqKey, tokKey], [signed(requestDelta), signed(tokenDelta)])) !== null;
  }

  async function refundQuota(key, { requestCost = 1, tokenCost, refundCap, windowSeconds }) {
    const raw = await run(QUOTA_REFUND_SCRIPT, quotaKeys(key), [
      whole(requestCost), whole(tokenCost), whole(refundCap), String(Math.max(1, Math.ceil(windowSeconds)))
    ]);
    if (!raw) return null;
    const [refunded, refundsUsed] = raw.map(Number);
    return { refunded: refunded === 1, refundsUsed, refundCap };
  }

  // A rate-limit store (server/rateLimit.js contract) that counts in the
  // shared database and falls back to `local` per call.
  function rateLimitStore(name, windowMs, local = createMemoryRateLimitStore(windowMs)) {
    return {
      async increment(key) {
        const raw = await run(RATE_LIMIT_SCRIPT, [`${KEY_PREFIX}rl:${name}:${counterId(key)}`], [String(windowMs)]);
        if (!raw) return local.increment(key);
        const [totalHits, ttlMs] = raw.map(Number);
        return { totalHits, resetTime: new Date(now() + (ttlMs > 0 ? ttlMs : windowMs)) };
      },
      size: () => local.size()
    };
  }

  return {
    configured: Boolean(client),
    reserveQuota,
    adjustQuota,
    refundQuota,
    rateLimitStore
  };
}

export function createSharedCounterStoreFromEnv(env = process.env, options = {}) {
  const url = env.QUOTA_REDIS_REST_URL;
  const token = env.QUOTA_REDIS_REST_TOKEN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const client = url && token
    ? new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(timeoutMs) })
    : null;
  return createSharedCounterStore({ ...options, client, timeoutMs });
}

// AI quota accounting over one or more scopes ([{ key, requestLimit,
// tokenLimit }]). A request is admitted only when every scope has room; a
// scope that rejects releases the ones already taken. Each scope remembers
// which backend admitted it so settlement and refunds go to the same place.
export function createQuotaLedger({ shared = null, local = createSessionQuotaStore() } = {}) {
  async function releaseEntries(entries, { requestCost, tokenCost }) {
    for (const entry of entries) {
      const done = entry.shared
        && await shared.adjustQuota(entry.key, { requestDelta: -requestCost, tokenDelta: -tokenCost });
      if (!done) local.release(entry.key, { requestCost, tokenCost });
    }
  }

  async function reserve(scopes, { requestCost = 1, tokenCost, windowSeconds }) {
    const tokens = Math.max(0, Math.ceil(Number(tokenCost) || 0));
    const entries = [];
    for (const scope of scopes) {
      const args = { requestCost, tokenCost: tokens, requestLimit: scope.requestLimit, tokenLimit: scope.tokenLimit, windowSeconds };
      const fromShared = shared ? await shared.reserveQuota(scope.key, args) : null;
      const result = fromShared ?? local.reserve(scope.key, args);
      if (!result.allowed) {
        await releaseEntries(entries, { requestCost, tokenCost: tokens });
        return { ...result, allowed: false, key: scope.key };
      }
      entries.push({ key: scope.key, shared: Boolean(fromShared), result });
    }
    const tightest = entries.reduce((max, entry) => (entry.result.requests > max.requests ? entry.result : max), entries[0].result);
    return {
      allowed: true,
      entries,
      shared: entries.every(entry => entry.shared),
      requests: tightest.requests,
      tokens: tightest.tokens,
      resetTime: tightest.resetTime
    };
  }

  // Moves the reserved token estimate toward the provider-reported actuals.
  async function commit(reservation, { tokenDelta }) {
    for (const entry of reservation?.entries ?? []) {
      const done = entry.shared && await shared.adjustQuota(entry.key, { tokenDelta });
      if (!done) local.commit(entry.key, { tokenDelta });
    }
  }

  async function refund(reservation, { requestCost = 1, tokenCost, refundCap, windowSeconds }) {
    const outcome = { refunded: true, refundsUsed: 0, refundCap };
    for (const entry of reservation?.entries ?? []) {
      const args = { requestCost, tokenCost, refundCap, windowSeconds };
      const result = (entry.shared ? await shared.refundQuota(entry.key, args) : null)
        ?? local.refund(entry.key, args);
      outcome.refunded = outcome.refunded && result.refunded;
      outcome.refundsUsed = Math.max(outcome.refundsUsed, result.refundsUsed);
    }
    return outcome;
  }

  return { reserve, commit, refund, prune: now => local.prune(now) };
}
