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

export function createRuntimeRateLimitStore({
  name,
  windowMs,
  isCacheEnabled,
  incrementRuntimeCounter,
  deleteRuntimeValue
}) {
  if (typeof isCacheEnabled !== 'function' || !isCacheEnabled()) return undefined;
  const ttlSeconds = Math.ceil(windowMs / 1000);
  return {
    async increment(key) {
      const result = await incrementRuntimeCounter(`rate-limit:${name}:${key}`, ttlSeconds);
      if (!result) {
        throw new Error('Runtime store unavailable while updating rate limit');
      }
      return {
        totalHits: result.count,
        resetTime: result.resetTime
      };
    },
    async decrement() {
      // Limits in this service do not use skipSuccessfulRequests/skipFailedRequests.
    },
    async resetKey(key) {
      await deleteRuntimeValue?.(`rate-limit:${name}:${key}`);
    }
  };
}

export function createMemoryRateLimitStore(windowMs) {
  const hits = new Map();
  return {
    async increment(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetTime.getTime() <= now) {
        entry = { totalHits: 0, resetTime: new Date(now + windowMs) };
      }
      entry.totalHits += 1;
      hits.set(key, entry);
      return entry;
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
  isCacheEnabled,
  incrementRuntimeCounter,
  deleteRuntimeValue,
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
    const store = createRuntimeRateLimitStore({
      name,
      windowMs,
      isCacheEnabled,
      incrementRuntimeCounter,
      deleteRuntimeValue
    }) || createMemoryRateLimitStore(windowMs);
    return createRateLimiter({
      windowMs,
      max,
      keyGenerator,
      handler,
      skip,
      name,
      store
    });
  };
}
