/**
 * Upstash Redis Cache Service
 *
 * Provides persistent caching across Cloud Run deployments for:
 * - AI report generation (model-specific provider responses)
 * - WinDBG analysis results
 *
 * Cache keys are based on content hashes to ensure deterministic lookups.
 * Upstash is optional: every helper fails open (a miss or a skipped write),
 * and no runtime state lives here — correctness never depends on Redis.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  ZSTD_DICTIONARY: 'cachemeta:zstd:dictionary',
};

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

// Initialize Redis client (lazy initialization)
let redis = null;
let analysisRedis = null;
let cacheEnabled = false;
let analysisCodec = null;
let dictionaryManager = null;
let lastDictionaryRegistration = 0;
let cacheZstdWritesEnabled = DEFAULT_CACHE_ZSTD_WRITES_ENABLED;

// On/off switch for Upstash. REDIS_ENABLED (true/false) wins so a live service
// can be flipped without a build; otherwise the committed redis.cfg decides
// ("enabled" / "disabled"). A missing or blank switch means enabled.
const REDIS_CONFIG_PATH = fileURLToPath(new URL('../redis.cfg', import.meta.url));
const REDIS_OFF_VALUES = new Set(['disabled', 'off', 'false', '0']);

function parseRedisSwitch(raw) {
  const value = String(raw ?? '')
    .split('\n')
    .map(line => line.replace(/#.*/, '').trim().toLowerCase())
    .find(Boolean);
  return value ? !REDIS_OFF_VALUES.has(value) : null;
}

export function isRedisConfigEnabled({ env = process.env, configPath = REDIS_CONFIG_PATH } = {}) {
  const fromEnv = parseRedisSwitch(env.REDIS_ENABLED);
  if (fromEnv !== null) return fromEnv;
  try {
    return parseRedisSwitch(fs.readFileSync(configPath, 'utf8')) ?? true;
  } catch {
    return true;
  }
}

// Runtime breaker: once Upstash fails in a way that will not clear on its own
// (plan/quota limit, rejected credentials) or keeps failing, stop using it —
// every cache helper then answers as a miss instead of failing requests — and
// re-probe later. Upstash holds only disposable cache data, so switching back
// on mid-process is safe.
const FATAL_REDIS_ERROR = /max (?:daily |monthly )?requests? limit exceeded|bandwidth limit exceeded|WRONGPASS|NOAUTH|NOPERM|\bunauthori[sz]ed\b/i;
const REDIS_CONSECUTIVE_FAILURE_LIMIT = 10;
const REPROBE_AFTER_TRANSIENT_MS = 5 * 60 * 1000;
const REPROBE_AFTER_FATAL_MS = 6 * 60 * 60 * 1000;
let redisConsecutiveFailures = 0;
let redisDisabledReason = null;
let reprobeTimer = null;

function scheduleReprobe(reason) {
  clearTimeout(reprobeTimer);
  reprobeTimer = setTimeout(reprobe, FATAL_REDIS_ERROR.test(reason) ? REPROBE_AFTER_FATAL_MS : REPROBE_AFTER_TRANSIENT_MS);
  reprobeTimer.unref?.();
}

async function reprobe() {
  reprobeTimer = null;
  if (cacheEnabled || !redis || !analysisRedis) return;
  try {
    await redis.ping();
    cacheEnabled = true;
    redisDisabledReason = null;
    redisConsecutiveFailures = 0;
    console.log('[Cache] Redis re-enabled after a successful re-probe');
  } catch (error) {
    scheduleReprobe(error?.message || String(error));
  }
}

export function disableRedis(reason) {
  if (!cacheEnabled) return;
  cacheEnabled = false;
  redisDisabledReason = String(reason);
  console.error(`[Cache] Redis disabled (${redisDisabledReason}); analysis cache off until a re-probe succeeds`);
  scheduleReprobe(redisDisabledReason);
}

export function getRedisDisabledReason() {
  return redisDisabledReason;
}

function noteRedisSuccess() {
  redisConsecutiveFailures = 0;
}

function noteRedisFailure(error) {
  const message = error?.message || String(error);
  redisConsecutiveFailures += 1;
  if (FATAL_REDIS_ERROR.test(message)) {
    disableRedis(message);
  } else if (redisConsecutiveFailures >= REDIS_CONSECUTIVE_FAILURE_LIMIT) {
    disableRedis(`${redisConsecutiveFailures} consecutive failures, last: ${message}`);
  }
}

// Observes every promise-returning client call (pipeline/multi exec included)
// for the breaker without changing what the caller receives.
function withFailureTap(client) {
  const tapped = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (result === target) return tapped;
        if (result && typeof result.then === 'function') {
          result.then(noteRedisSuccess, noteRedisFailure);
        } else if (result && typeof result === 'object' && (prop === 'pipeline' || prop === 'multi')) {
          return withFailureTap(result);
        }
        return result;
      };
    }
  });
  return tapped;
}

/**
 * Initialize the Redis cache connection
 * Call this at server startup
 */
export function initCache({ redisClient, analysisClient } = {}) {
  clearTimeout(reprobeTimer);
  reprobeTimer = null;
  redisConsecutiveFailures = 0;
  redisDisabledReason = null;
  if (redisClient || analysisClient) {
    if (!redisClient || !analysisClient) {
      throw new TypeError('Both redisClient and analysisClient are required when injecting cache clients');
    }
    redis = withFailureTap(redisClient);
    analysisRedis = withFailureTap(analysisClient);
    cacheEnabled = true;
    return true;
  }

  if (!isRedisConfigEnabled()) {
    redisDisabledReason = 'turned off by redis.cfg / REDIS_ENABLED';
    console.log('[Cache] Upstash Redis turned off (redis.cfg / REDIS_ENABLED) - analysis cache disabled');
    return false;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.log('[Cache] Upstash Redis not configured - caching disabled');
    console.log('[Cache] Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable');
    return false;
  }

  try {
    redis = withFailureTap(new Redis({
      url,
      token,
    }));
    analysisRedis = withFailureTap(createUpstashBinaryClient({ url, token }));
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
 * more than the analysis-cache helpers (the stats baseline export). Returns
 * null while caching is off.
 */
export function getRedisCommandClient() {
  return isCacheEnabled() ? redis : null;
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
    // No analysis cache to write to while Redis is off; never block startup.
    cacheZstdWritesEnabled = false;
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
    // The cache is optional: without a usable dictionary, write plain JSON
    // rather than refusing to boot.
    analysisCodec = null;
    dictionaryManager = null;
    cacheZstdWritesEnabled = false;
    console.warn(`[Cache] Zstandard dictionary unavailable; uncompressed analysis cache only: ${error.message}`);
    return false;
  }

  try {
    await registerCurrentDictionary({ force: true });
  } catch (error) {
    // Without a registered dictionary other instances could not decode our
    // values, so publish uncompressed until a later write re-registers it.
    if (cacheZstdWritesEnabled) {
      cacheZstdWritesEnabled = false;
      console.warn(`[Cache] Zstandard dictionary registry unavailable; writing uncompressed: ${error.message}`);
    } else {
      console.warn(`[Cache] Zstandard dictionary registry unavailable in reader-only mode: ${error.message}`);
    }
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

async function encodeAnalysisValue(value) {
  if (analysisCodec) {
    return analysisCodec.encode(value, { compress: cacheZstdWritesEnabled });
  }
  if (cacheZstdWritesEnabled) {
    throw new Error('Compressed cache writes are enabled without a loaded dictionary');
  }
  return Buffer.from(JSON.stringify(value), 'utf8');
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
 * Merge and cache complete analysis (WinDBG + AI report)
 * @param {string} fileHash - The file or prompt content hash
 * @param {object} data - { windbgOutput, analysisSignalText, structured, aiReport, aiModel }
 */
export async function setCachedAnalysis(fileHash, data) {
  if (!isCacheEnabled()) return false;

  try {
    const key = getAnalysisKey(fileHash);
    // One read to merge per-model reports into the existing entry, one write.
    // Concurrent writers can race (last write wins); the loser's report is
    // simply recomputed on a later miss — the cache is disposable.
    const existingValue = await analysisRedis.get(key);
    let existing = {};
    if (existingValue) {
      try {
        const decoded = await decodeAnalysisValue(existingValue);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('decoded cache value is not an object');
        }
        existing = decoded;
      } catch (error) {
        // A corrupt or unreadable entry must not block a fresh result from replacing it.
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
    const cacheData = {
      ...existing,
      ...(data.windbgOutput !== undefined ? { windbgOutput: data.windbgOutput } : {}),
      ...(data.analysisSignalText !== undefined ? { analysisSignalText: data.analysisSignalText } : {}),
      ...(data.structured !== undefined ? { structured: data.structured } : {}),
      ...(data.aiReport !== undefined ? { aiReport: data.aiReport } : {}),
      ...(data.aiModel !== undefined ? { aiModel: data.aiModel } : {}),
      ...(modelReports !== undefined ? { aiReports: modelReports } : {}),
      timestamp: Date.now()
    };

    const storedValue = await encodeAnalysisValue(cacheData);
    if (isZstdEnvelope(storedValue)) {
      // Ensure the dictionary survives independently before publishing an
      // entry that references it. `ensurePresent` detects a whole-DB flush.
      await registerCurrentDictionary({ ensurePresent: true });
    }
    await analysisRedis.set(key, storedValue, { ex: CACHE_TTL_SECONDS });
    knownCached.set(fileHash, Date.now());
    console.log(
      `[Cache] Analysis cached with hash ${fileHash.substring(0, 12)}... (TTL: 7d, storage: ${isZstdEnvelope(storedValue) ? 'zstd' : 'json'}, bytes: ${storedValue.length})`
    );
    return true;
  } catch (error) {
    console.error('[Cache] Error caching analysis:', error.message);
    return false;
  }
}

// Hashes known to be cached (fileHash -> when confirmed), so repeated
// pre-upload checks cost nothing. Entries are written with usable data only,
// so key existence stands in for "usable" without downloading the value.
const KNOWN_CACHED_TTL_MS = 10 * 60 * 1000;
const KNOWN_CACHED_MAX = 5000;
const knownCached = new Map();

/**
 * Check whether an analysis is cached (EXISTS; never downloads the value).
 * @param {string} fileHash - The file content hash
 * @returns {Promise<boolean>}
 */
export async function isAnalysisCached(fileHash) {
  if (!isCacheEnabled()) return false;
  const confirmedAt = knownCached.get(fileHash);
  if (confirmedAt && Date.now() - confirmedAt < KNOWN_CACHED_TTL_MS) return true;

  try {
    const exists = Number(await redis.exists(getAnalysisKey(fileHash))) > 0;
    if (exists) {
      if (knownCached.size >= KNOWN_CACHED_MAX) knownCached.delete(knownCached.keys().next().value);
      knownCached.set(fileHash, Date.now());
    }
    return exists;
  } catch (error) {
    console.error('[Cache] Error checking analysis cache:', error.message);
    return false;
  }
}
