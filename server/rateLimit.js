import net from 'net';

export function normalizeRateLimitIp(value) {
  const ip = String(value || 'unknown').split(',')[0].trim();
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(normalized)) return normalized;
  if (net.isIPv6(normalized)) return normalized.toLowerCase();
  return normalized || 'unknown';
}

export function jsonRateLimitHandler(_req, res) {
  res.status(429).json({
    success: false,
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMITED'
  });
}

// Per-instance fixed-window counters. Limits are deliberately not shared
// across Cloud Run instances: a shared store cost ~2 Upstash commands per
// limiter per request, and session affinity keeps a client on one instance.
export function createMemoryRateLimitStore(windowMs, { sweepIntervalMs = 60 * 1000 } = {}) {
  const hits = new Map();
  let nextSweepAt = 0;
  return {
    async increment(key) {
      const now = Date.now();
      // Periodic (not per-request) sweep so expired keys cannot accumulate.
      if (now >= nextSweepAt) {
        nextSweepAt = now + sweepIntervalMs;
        for (const [existingKey, entry] of hits) {
          if (entry.resetTime.getTime() <= now) hits.delete(existingKey);
        }
      }
      let entry = hits.get(key);
      if (!entry || entry.resetTime.getTime() <= now) {
        entry = { totalHits: 0, resetTime: new Date(now + windowMs) };
        hits.set(key, entry);
      }
      entry.totalHits += 1;
      return entry;
    },
    size() {
      return hits.size;
    }
  };
}

function secondsUntil(resetTime) {
  const resetMs = resetTime instanceof Date
    ? resetTime.getTime()
    : new Date(resetTime).getTime();
  if (!Number.isFinite(resetMs)) return 1;
  return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
}

function setRateLimitHeaders(res, { max, remaining, resetSeconds, windowMs }) {
  res.setHeader('RateLimit-Policy', `${max};w=${Math.ceil(windowMs / 1000)}`);
  res.setHeader('RateLimit-Limit', String(max));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.setHeader('RateLimit-Reset', String(resetSeconds));
}

export function createRateLimiter({
  windowMs,
  max,
  keyGenerator,
  handler = jsonRateLimitHandler,
  skip = () => false,
  name = 'generic',
  store
}) {
  if (typeof keyGenerator !== 'function') {
    throw new TypeError('createRateLimiter requires a keyGenerator function');
  }
  const limiterStore = store || createMemoryRateLimitStore(windowMs);
  return async (req, res, next) => {
    try {
      if (skip(req)) return next();
      const key = await keyGenerator(req);
      const result = await limiterStore.increment(key);
      const totalHits = result.totalHits ?? result.count ?? 0;
      const resetTime = result.resetTime ?? new Date(Date.now() + windowMs);
      const resetSeconds = secondsUntil(resetTime);
      setRateLimitHeaders(res, {
        max,
        remaining: max - totalHits,
        resetSeconds,
        windowMs
      });
      if (totalHits > max) return handler(req, res);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createRateLimiterFactory({
  defaultKeyGenerator,
  defaultHandler = jsonRateLimitHandler
}) {
  return function makeLimiter({
    windowMs,
    max,
    keyGenerator = defaultKeyGenerator,
    handler = defaultHandler,
    skip,
    name = 'generic'
  }) {
    return createRateLimiter({
      windowMs,
      max,
      keyGenerator,
      handler,
      skip,
      name,
      store: createMemoryRateLimitStore(windowMs)
    });
  };
}
