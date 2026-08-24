/**
 * Upstash Redis Cache Service
 *
 * Provides persistent caching across Cloud Run deployments for:
 * - AI report generation (model-specific provider responses)
 * - WinDBG analysis results
 *
 * Cache keys are based on content hashes to ensure deterministic lookups.
 */

import { Redis } from '@upstash/redis';
import xxhash from 'xxhash-wasm';
import { hashBytes, hashString } from '../shared/hash.js';
import {
  createAnalysisCacheCodec,
  createDictionaryManager,
  getDictionaryId,
  isZstdEnvelope,
} from './cacheCodec.js';
import { createUpstashBinaryClient } from './upstashBinary.js';

// Cache TTL: 7 days maximum
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800 seconds

// Initialize xxhash
let hasher = null;
const hasherReady = xxhash().then(xxhashModule => {
  hasher = xxhashModule;
  console.log('[Cache] XXHash initialized for cache key generation');
});

export async function initHashing() {
  await hasherReady;
}

// Cache key prefixes
const CACHE_PREFIX = {
  ANALYSIS: 'analysis',
  RUNTIME: 'runtime',
  ZSTD_DICTIONARY: 'cachemeta:zstd:dictionary',
};

const RELEASE_RUNTIME_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_RUNTIME_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const TRANSITION_RUNTIME_JOB_WITH_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local current = redis.call('GET', KEYS[2])
  if not current then
    return 0
  end
  local decoded = cjson.decode(current)
  local version = tonumber(decoded.version) or 0
  if version ~= tonumber(ARGV[2]) then
    return 0
  end
  if decoded.status == 'completed' or decoded.status == 'failed' then
    return 0
  end
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
  return 1
end
return 0
`;

const CREATE_RUNTIME_JOB_WITH_MAPPING_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local existing = redis.call('GET', KEYS[3])
  if existing and existing ~= ARGV[2] then
    return -1
  end
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
  redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[4])
  return 1
end
return 0
`;

const DELETE_RUNTIME_VALUE_IF_EQUALS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const CACHE_ZSTD_DICTIONARY_PATH =
  process.env.CACHE_ZSTD_DICTIONARY_PATH || '/secrets/redis-zstd/dictionary';
const DEFAULT_CACHE_ZSTD_WRITES_ENABLED = process.env.CACHE_ZSTD_WRITES_ENABLED === 'true';
const CACHE_ZSTD_DICTIONARY_REFRESH_MS_DEFAULT = 5 * 60 * 1000;
// How often publishes re-probe the registry through SETNX to detect an
// externally initiated whole-database flush.
const CACHE_ZSTD_FLUSH_PROBE_MS_DEFAULT = 60 * 1000;
let cacheZstdRefreshMs = CACHE_ZSTD_DICTIONARY_REFRESH_MS_DEFAULT;
let cacheZstdFlushProbeMs = CACHE_ZSTD_FLUSH_PROBE_MS_DEFAULT;
const CACHE_ZSTD_DICTIONARY_BYTES = 32 * 1024;
const CACHE_MERGE_MAX_ATTEMPTS = 3;

// Initialize Redis client (lazy initialization)
let redis = null;
let analysisRedis = null;
let cacheEnabled = false;
let analysisCodec = null;
let dictionaryManager = null;
let lastDictionaryRegistration = 0;
let cacheZstdWritesEnabled = DEFAULT_CACHE_ZSTD_WRITES_ENABLED;

/**
 * Initialize the Redis cache connection
 * Call this at server startup
 */
export function initCache({ redisClient, analysisClient } = {}) {
  if (redisClient || analysisClient) {
    if (!redisClient || !analysisClient) {
      throw new TypeError('Both redisClient and analysisClient are required when injecting cache clients');
    }
    redis = redisClient;
    analysisRedis = analysisClient;
    cacheEnabled = true;
    return true;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.log('[Cache] Upstash Redis not configured - caching disabled');
    console.log('[Cache] Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable');
    return false;
  }

  try {
    redis = new Redis({
      url,
      token,
    });
    analysisRedis = createUpstashBinaryClient({ url, token });
    cacheEnabled = true;
    console.log('[Cache] Upstash Redis initialized successfully');
    return true;
  } catch (error) {
    console.error('[Cache] Failed to initialize Upstash Redis:', error.message);
    return false;
  }
}

/**
 * Check if caching is enabled
 */
export function isCacheEnabled() {
  return cacheEnabled && redis !== null && analysisRedis !== null;
}

/**
 * JSON-command Redis client (hash/zset/sorted-set ops) for modules that need
 * more than the runtime counter helpers. Returns null while caching is off.
 */
export function getRedisCommandClient() {
  return isCacheEnabled() ? redis : null;
}

function getRuntimeKey(key) {
  return `${CACHE_PREFIX.RUNTIME}:${key}`;
}

function parseCachedValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function getDictionaryRegistryKey(dictionaryId) {
  return `${CACHE_PREFIX.ZSTD_DICTIONARY}:${dictionaryId}`;
}

async function fetchRegisteredDictionary(dictionaryId) {
  if (!analysisRedis) return null;
  return analysisRedis.get(getDictionaryRegistryKey(dictionaryId));
}

async function registerCurrentDictionary({ force = false, ensurePresent = false } = {}) {
  if (!redis || !dictionaryManager) return false;
  const now = Date.now();
  const current = dictionaryManager.getCurrentDictionary();
  const registryKey = getDictionaryRegistryKey(current.id);
  const sinceLastRegistration = now - lastDictionaryRegistration;

  // SETNX uses Redis's write path, so it cannot return a stale pre-flush read:
  // publishes re-probe the registry through SETNX so a whole-DB flush is
  // detected within CACHE_ZSTD_FLUSH_PROBE_MS instead of on every write, and
  // other callers use the longer refresh window.
  const minInterval = ensurePresent
    ? cacheZstdFlushProbeMs
    : cacheZstdRefreshMs;
  if (!force && sinceLastRegistration < minInterval) return true;

  const created = await analysisRedis.setNx(registryKey, current.bytes);
  if (!created && (force || sinceLastRegistration >= cacheZstdRefreshMs)) {
    const registered = await analysisRedis.get(registryKey);
    if (!registered || getDictionaryId(registered) !== current.id) {
      // A partial or foreign write won the original SETNX race. Replace it
      // once before giving up so a single bad key cannot crash-loop writers
      // at boot in writes-enabled mode.
      await analysisRedis.del(registryKey);
      const repaired = await analysisRedis.setNx(registryKey, current.bytes);
      if (!repaired) {
        const reread = await analysisRedis.get(registryKey);
        if (!reread || getDictionaryId(reread) !== current.id) {
          throw new Error(`Zstandard dictionary registry value ${current.id} failed integrity verification`);
        }
      }
      console.warn(
        `[Cache] Repaired zstd dictionary registry entry ${current.id.substring(0, 12)}... after integrity failure`
      );
    }
  }
  lastDictionaryRegistration = now;
  return true;
}

/**
 * Load and verify the dictionary mounted by Secret Manager. Reader-only
 * revisions still load the dictionary so they can decode values written by a
 * later, compression-enabled revision during a safe Cloud Run rollout.
 */
export async function initCacheCompression({
  dictionaryPath = CACHE_ZSTD_DICTIONARY_PATH,
  writesEnabled = DEFAULT_CACHE_ZSTD_WRITES_ENABLED,
  flushProbeMs,
  refreshIntervalMs,
} = {}) {
  if (typeof writesEnabled !== 'boolean') {
    throw new TypeError('writesEnabled must be a boolean');
  }
  for (const [name, value] of [['flushProbeMs', flushProbeMs], ['refreshIntervalMs', refreshIntervalMs]]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`${name} must be a non-negative number when provided`);
    }
  }
  cacheZstdWritesEnabled = writesEnabled;
  cacheZstdFlushProbeMs = flushProbeMs ?? CACHE_ZSTD_FLUSH_PROBE_MS_DEFAULT;
  cacheZstdRefreshMs = refreshIntervalMs ?? CACHE_ZSTD_DICTIONARY_REFRESH_MS_DEFAULT;

  if (!isCacheEnabled()) {
    if (cacheZstdWritesEnabled) {
      throw new Error('CACHE_ZSTD_WRITES_ENABLED requires an initialized Redis cache');
    }
    return false;
  }

  try {
    dictionaryManager = await createDictionaryManager({
      dictionaryPath,
      fetchDictionaryById: fetchRegisteredDictionary,
    });
    if (dictionaryManager.getCurrentDictionary().bytes.length !== CACHE_ZSTD_DICTIONARY_BYTES) {
      throw new Error(`Zstandard dictionary must be exactly ${CACHE_ZSTD_DICTIONARY_BYTES} bytes`);
    }
    analysisCodec = createAnalysisCacheCodec({ dictionaryManager });

    // Exercise dictionary compression and decompression before accepting
    // traffic. A repetitive probe guarantees the codec chooses an envelope.
    const probe = {
      windbgOutput: 'cache dictionary startup probe\n'.repeat(256),
      timestamp: 0,
    };
    const encodedProbe = await analysisCodec.encode(probe);
    if (!isZstdEnvelope(encodedProbe)) {
      throw new Error('Zstandard startup probe did not produce a compressed envelope');
    }
    const decodedProbe = await analysisCodec.decode(encodedProbe);
    if (decodedProbe.windbgOutput !== probe.windbgOutput) {
      throw new Error('Zstandard startup probe failed to round trip');
    }

  } catch (error) {
    analysisCodec = null;
    dictionaryManager = null;
    if (cacheZstdWritesEnabled) {
      throw new Error(`Compressed cache writes require a valid Zstandard dictionary: ${error.message}`, {
        cause: error,
      });
    }
    console.warn(`[Cache] Zstandard dictionary unavailable; legacy analysis cache only: ${error.message}`);
    return false;
  }

  try {
    await registerCurrentDictionary({ force: true });
  } catch (error) {
    if (cacheZstdWritesEnabled) {
      analysisCodec = null;
      dictionaryManager = null;
      throw new Error(`Compressed cache writes require a valid dictionary registry: ${error.message}`, {
        cause: error,
      });
    }
    console.warn(`[Cache] Zstandard dictionary registry unavailable in reader-only mode: ${error.message}`);
  }

  console.log(
    `[Cache] Zstandard dictionary ${dictionaryManager.currentDictionaryId.substring(0, 12)}... loaded; compressed writes ${cacheZstdWritesEnabled ? 'enabled' : 'disabled'}`
  );
  return true;
}

export function getCacheCompressionStatus() {
  return {
    dictionaryLoaded: analysisCodec !== null,
    dictionaryId: dictionaryManager?.currentDictionaryId || null,
    writesEnabled: cacheZstdWritesEnabled,
    transport: 'upstash-rest-binary',
  };
}

async function decodeAnalysisValue(value) {
  if (analysisCodec) return analysisCodec.decode(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.parse(Buffer.from(value).toString('utf8'));
  }
  return parseCachedValue(value);
}

function isDisposableAnalysisDecodeError(error) {
  return error instanceof SyntaxError || [
    'INVALID_ANALYSIS_CACHE_VALUE',
    'ANALYSIS_CACHE_VALUE_TOO_LARGE',
    'INVALID_ZSTD_ENVELOPE',
    'UNSUPPORTED_ZSTD_ENVELOPE_VERSION',
    'ZSTD_DECOMPRESSION_FAILED'
  ].includes(error?.code);
}

async function encodeAnalysisValue(value) {
  if (analysisCodec) {
    return analysisCodec.encode(value, { compress: cacheZstdWritesEnabled });
  }
  if (cacheZstdWritesEnabled) {
    throw new Error('Compressed cache writes are enabled without a loaded dictionary');
  }
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/**
 * Store short-lived runtime state that must survive Cloud Run instance routing
 * changes, such as verified sessions and per-session upload ownership.
 */
export async function setRuntimeValue(key, value, ttlSeconds) {
  if (!isCacheEnabled()) return false;

  try {
    await redis.set(getRuntimeKey(key), JSON.stringify(value), { ex: ttlSeconds });
    return true;
  } catch (error) {
    console.error('[Cache] Error setting runtime value:', error.message);
    return false;
  }
}

export async function getRuntimeValue(key) {
  if (!isCacheEnabled()) return null;

  try {
    const value = await redis.get(getRuntimeKey(key));
    if (!value) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    console.error('[Cache] Error getting runtime value:', error.message);
    return null;
  }
}

/**
 * Read runtime state without collapsing a Redis outage into a cache miss.
 * Durable job/status paths use this variant so callers can return a retryable
 * service error instead of incorrectly reporting that an accepted job vanished.
 */
export async function getRuntimeValueStrict(key) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }

  const value = await redis.get(getRuntimeKey(key));
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function decodeRuntimeString(value) {
  if (typeof value !== 'string') return value;
  // @upstash/redis automatically deserializes JSON by default, so a Redis
  // value stored as `"uid"` may already arrive as the bare `uid` string.
  return value.startsWith('"') ? JSON.parse(value) : value;
}

export async function getRuntimeStringValue(key) {
  if (!isCacheEnabled()) return null;

  try {
    const value = await redis.get(getRuntimeKey(key));
    if (value === null || value === undefined) return null;
    return decodeRuntimeString(value);
  } catch (error) {
    console.error('[Cache] Error getting runtime string value:', error.message);
    return null;
  }
}

export async function getRuntimeStringValueStrict(key) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }

  const value = await redis.get(getRuntimeKey(key));
  if (value === null || value === undefined) return null;
  return decodeRuntimeString(value);
}

/**
 * Acquire a short Redis lease. The caller supplies an opaque random token and
 * must use the token-checked renew/release helpers below.
 */
export async function tryAcquireRuntimeLease(key, token, ttlSeconds) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }
  if (!token || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Runtime lease requires a token and positive TTL');
  }

  const result = await redis.set(getRuntimeKey(key), token, {
    nx: true,
    ex: Math.ceil(ttlSeconds)
  });
  return result === 'OK';
}

export async function renewRuntimeLease(key, token, ttlSeconds) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }
  if (!token || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Runtime lease requires a token and positive TTL');
  }

  const renewed = await redis.eval(
    RENEW_RUNTIME_LEASE_SCRIPT,
    [getRuntimeKey(key)],
    [token, String(Math.ceil(ttlSeconds))]
  );
  return Number(renewed) === 1;
}

export async function releaseRuntimeLease(key, token) {
  if (!isCacheEnabled()) return false;
  if (!token) return false;

  try {
    const released = await redis.eval(
      RELEASE_RUNTIME_LEASE_SCRIPT,
      [getRuntimeKey(key)],
      [token]
    );
    return Number(released) === 1;
  } catch (error) {
    console.error('[Cache] Error releasing runtime lease:', error.message);
    return false;
  }
}

/**
 * Atomically transition a non-terminal versioned job only while the caller
 * still owns its lease. This closes the expiry race between a separate lease
 * check and a Redis SET and rejects stale/terminal writers.
 */
export async function transitionRuntimeJobWithLease(key, leaseKey, token, expectedVersion, value, ttlSeconds) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }
  if (!token || !Number.isInteger(expectedVersion) || expectedVersion < 0 || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Leased runtime write requires a token, version, and positive TTL');
  }

  const stored = await redis.eval(
    TRANSITION_RUNTIME_JOB_WITH_LEASE_SCRIPT,
    [getRuntimeKey(leaseKey), getRuntimeKey(key)],
    [token, String(expectedVersion), JSON.stringify(value), String(Math.ceil(ttlSeconds))]
  );
  return Number(stored) === 1;
}

/**
 * Atomically publish an accepted job and its file-hash -> UID reuse mapping
 * while the caller owns the per-file submission lease.
 */
export async function createRuntimeJobWithMapping(
  key,
  mappingKey,
  leaseKey,
  token,
  mappingValue,
  value,
  ttlSeconds
) {
  if (!isCacheEnabled()) {
    throw new Error('Redis runtime store is not configured');
  }
  if (!token || mappingValue === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Mapped runtime job requires a token, mapping value, and positive TTL');
  }

  const stored = await redis.eval(
    CREATE_RUNTIME_JOB_WITH_MAPPING_SCRIPT,
    [getRuntimeKey(leaseKey), getRuntimeKey(key), getRuntimeKey(mappingKey)],
    [
      token,
      JSON.stringify(mappingValue),
      JSON.stringify(value),
      String(Math.ceil(ttlSeconds))
    ]
  );
  return Number(stored) === 1;
}

/** Delete a JSON runtime value only if it still equals the expected value. */
export async function deleteRuntimeValueIfEquals(key, expectedValue) {
  if (!isCacheEnabled()) return false;
  const deleted = await redis.eval(
    DELETE_RUNTIME_VALUE_IF_EQUALS_SCRIPT,
    [getRuntimeKey(key)],
    [JSON.stringify(expectedValue)]
  );
  return Number(deleted) === 1;
}

export async function deleteRuntimeValue(key) {
  if (!isCacheEnabled()) return false;

  try {
    await redis.del(getRuntimeKey(key));
    return true;
  } catch (error) {
    console.error('[Cache] Error deleting runtime value:', error.message);
    return false;
  }
}

export async function checkCacheConnection() {
  if (!isCacheEnabled()) return false;

  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error('[Cache] Redis health check failed:', error.message);
    return false;
  }
}

export async function incrementRuntimeCounter(key, ttlSeconds, delta = 1) {
  if (!isCacheEnabled()) return null;

  try {
    const runtimeKey = getRuntimeKey(key);
    const count = Number(await redis.incrby(runtimeKey, delta));
    if (!Number.isFinite(count)) {
      throw new Error('Redis INCR returned a non-numeric counter');
    }
    if (count === delta) {
      await redis.expire(runtimeKey, ttlSeconds);
    }

    let ttl = Number(await redis.ttl(runtimeKey));
    if (!Number.isFinite(ttl) || ttl < 0) {
      await redis.expire(runtimeKey, ttlSeconds);
      ttl = ttlSeconds;
    }

    return {
      count,
      resetTime: new Date(Date.now() + ttl * 1000)
    };
  } catch (error) {
    console.error('[Cache] Error incrementing runtime counter:', error.message);
    return null;
  }
}

/**
 * Generate an xxhash64 hash of content for cache keys.
 */
export function hashContent(content) {
  if (!hasher) {
    throw new Error('XXHash not initialized');
  }

  if (typeof content === 'string') {
    return hashString(hasher, content);
  }
  if (Buffer.isBuffer(content)) {
    return hashBytes(hasher, content);
  }
  return hashString(hasher, JSON.stringify(content));
}

// ============================================================
// Combined Analysis Cache
// ============================================================

/**
 * Generate cache key for combined analysis
 * Key is based on the current content hash. For dump-level analysis this is
 * the file hash; for prompt-only AI calls it is the validated prompt hash.
 */
function getAnalysisKey(fileHash) {
  return `${CACHE_PREFIX.ANALYSIS}:${fileHash}`;
}

/**
 * Namespace for prompt-keyed analysis entries. These have no owning session,
 * so they must never be addressable through the file-hash path that
 * /api/cache/get exposes to clients.
 */
export function getPromptCacheKey(promptHash) {
  return `prompt:${promptHash}`;
}

/**
 * Get cached complete analysis (WinDBG + AI report) by file hash
 * @param {string} fileHash - The file content hash
 * @returns {Promise<object|null>} Cached analysis { windbgOutput, aiReport, aiReports, timestamp } or null
 */
export async function getCachedAnalysis(fileHash) {
  if (!isCacheEnabled()) return null;

  let cached = null;
  try {
    const key = getAnalysisKey(fileHash);
    cached = await analysisRedis.get(key);

    if (cached) {
      console.log(`[Cache] Analysis cache HIT for hash ${fileHash.substring(0, 12)}...`);
      return await decodeAnalysisValue(cached);
    }

    console.log(`[Cache] Analysis cache MISS for hash ${fileHash.substring(0, 12)}...`);
    return null;
  } catch (error) {
    // Distinguish a genuine miss from a value that exists but cannot be
    // served: reader-only revisions without a loaded dictionary meeting zstd
    // values written by a later rollout must not masquerade as cache misses.
    if (cached === null || cached === undefined) {
      console.error('[Cache] Analysis cache transport error:', error.message);
    } else if (isZstdEnvelope(cached) && !analysisCodec) {
      console.error(
        `[Cache] Zstd analysis value present but decoder unavailable for hash ${fileHash.substring(0, 12)}... (dictionary not loaded)`
      );
    } else {
      console.error(
        `[Cache] Stored analysis value failed to decode for hash ${fileHash.substring(0, 12)}...:`,
        error.message
      );
    }
    return null;
  }
}

/**
 * Strict analysis-cache read for resumable workflows. Dependency/configuration
 * failures propagate; values proven corrupt are deleted and become real misses.
 */
export async function getCachedAnalysisStrict(fileHash) {
  if (!isCacheEnabled()) {
    throw new Error('Redis analysis cache is not configured');
  }

  const key = getAnalysisKey(fileHash);
  const cached = await analysisRedis.get(key);
  if (!cached) return null;
  if (isZstdEnvelope(cached) && !analysisCodec) {
    const error = new Error('Zstandard analysis cache value cannot be decoded by this revision');
    error.code = 'ANALYSIS_CACHE_DECODER_UNAVAILABLE';
    throw error;
  }
  try {
    return await decodeAnalysisValue(cached);
  } catch (error) {
    // A fetched value that is provably malformed is disposable cache state.
    // Remove it so a valid dump can be recomputed instead of deterministically
    // failing every POST. Dictionary/config/transport failures are deliberately
    // not classified here and continue to propagate to the caller.
    if (!isDisposableAnalysisDecodeError(error)) throw error;
    console.warn(
      `[Cache] Removing corrupt analysis value for hash ${fileHash.substring(0, 12)}...: ${error.message}`
    );
    await analysisRedis.del(key);
    return null;
  }
}

/**
 * Merge and cache complete analysis (WinDBG + AI report)
 * @param {string} fileHash - The file or prompt content hash
 * @param {object} data - { windbgOutput, analysisSignalText, structured, aiReport, aiModel }
 */
export async function setCachedAnalysis(fileHash, data) {
  if (!isCacheEnabled()) return false;

  try {
    const key = getAnalysisKey(fileHash);

    for (let attempt = 1; attempt <= CACHE_MERGE_MAX_ATTEMPTS; attempt += 1) {
      const existingValue = await analysisRedis.get(key);
      let existing = {};
      let previousRevision = 0;
      if (existingValue) {
        try {
          const decoded = await decodeAnalysisValue(existingValue);
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new Error('decoded cache value is not an object');
          }
          existing = decoded;
          previousRevision = Number.isFinite(Number(decoded.rev)) ? Number(decoded.rev) : 0;
        } catch (error) {
          // Cache values are disposable. A corrupt or unreadable entry should
          // not permanently prevent a freshly computed result from replacing it.
          console.warn(
            `[Cache] Replacing unreadable analysis value for hash ${fileHash.substring(0, 12)}...: ${error.message}`
          );
        }
      }
      const modelReports = data.aiReport !== undefined && data.aiModel
        ? {
            ...(existing.aiReports && typeof existing.aiReports === 'object' ? existing.aiReports : {}),
            [data.aiModel]: data.aiReport
          }
        : existing.aiReports;
      const revision = previousRevision + 1;
      const cacheData = {
        ...existing,
        ...(data.windbgOutput !== undefined ? { windbgOutput: data.windbgOutput } : {}),
        ...(data.analysisSignalText !== undefined ? { analysisSignalText: data.analysisSignalText } : {}),
        ...(data.structured !== undefined ? { structured: data.structured } : {}),
        ...(data.aiReport !== undefined ? { aiReport: data.aiReport } : {}),
        ...(data.aiModel !== undefined ? { aiModel: data.aiModel } : {}),
        ...(modelReports !== undefined ? { aiReports: modelReports } : {}),
        timestamp: Date.now(),
        rev: revision
      };

      const storedValue = await encodeAnalysisValue(cacheData);
      if (isZstdEnvelope(storedValue)) {
        // Ensure the dictionary survives independently before publishing an
        // entry that references it. `ensurePresent` detects a whole-DB flush.
        await registerCurrentDictionary({ ensurePresent: true });
      }
      await analysisRedis.set(key, storedValue, { ex: CACHE_TTL_SECONDS });

      // Confirm this revision survived. A concurrent publisher that wrote
      // between our GET and SET bumps rev past ours, so its merge wins and we
      // redo ours over its value instead of silently reverting it.
      let confirmedRevision = null;
      try {
        const latestValue = await analysisRedis.get(key);
        const latest = latestValue ? await decodeAnalysisValue(latestValue) : null;
        confirmedRevision = latest && Number.isFinite(Number(latest.rev)) ? Number(latest.rev) : null;
      } catch {
        confirmedRevision = null;
      }
      if (confirmedRevision === revision) {
        const storage = isZstdEnvelope(storedValue) ? 'zstd' : 'json';
        console.log(
          `[Cache] Analysis cached with hash ${fileHash.substring(0, 12)}... (TTL: 7d, storage: ${storage}, bytes: ${storedValue.length})`
        );
        return true;
      }
      console.warn(
        `[Cache] Lost analysis merge race for hash ${fileHash.substring(0, 12)}..., retrying (${attempt}/${CACHE_MERGE_MAX_ATTEMPTS})`
      );
    }

    console.error(
      `[Cache] Abandoning analysis merge for hash ${fileHash.substring(0, 12)}... after ${CACHE_MERGE_MAX_ATTEMPTS} attempts`
    );
    return false;
  } catch (error) {
    console.error('[Cache] Error caching analysis:', error.message);
    return false;
  }
}

/**
 * Check if analysis is cached with usable data
 * @param {string} fileHash - The file content hash
 * @returns {Promise<boolean>}
 */
export async function isAnalysisCached(fileHash) {
  if (!isCacheEnabled()) return false;

  try {
    // Fetch and verify usable data exists (not just key existence)
    const cached = await getCachedAnalysis(fileHash);
    return !!(cached && (cached.windbgOutput || cached.aiReport));
  } catch (error) {
    console.error('[Cache] Error checking analysis cache:', error.message);
    return false;
  }
}
