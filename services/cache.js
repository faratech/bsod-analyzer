/**
 * Upstash Redis Cache Service
 *
 * Provides persistent caching across Cloud Run deployments for:
 * - AI report generation (Gemini API responses)
 * - WinDBG analysis results
 *
 * Cache keys are based on content hashes to ensure deterministic lookups.
 */

import { Redis } from '@upstash/redis';
import xxhash from 'xxhash-wasm';
import { hashBytes, hashString } from '../shared/hash.js';

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
};

// Initialize Redis client (lazy initialization)
let redis = null;
let cacheEnabled = false;

/**
 * Initialize the Redis cache connection
 * Call this at server startup
 */
export function initCache() {
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
  return cacheEnabled && redis !== null;
}

function getRuntimeKey(key) {
  return `${CACHE_PREFIX.RUNTIME}:${key}`;
}

function parseCachedValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
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

export async function incrementRuntimeCounter(key, ttlSeconds) {
  if (!isCacheEnabled()) return null;

  try {
    const runtimeKey = getRuntimeKey(key);
    const count = Number(await redis.incr(runtimeKey));
    if (!Number.isFinite(count)) {
      throw new Error('Redis INCR returned a non-numeric counter');
    }
    if (count === 1) {
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
 * Get cached complete analysis (WinDBG + AI report) by file hash
 * @param {string} fileHash - The file content hash
 * @returns {Promise<object|null>} Cached analysis { windbgOutput, aiReport, timestamp } or null
 */
export async function getCachedAnalysis(fileHash) {
  if (!isCacheEnabled()) return null;

  try {
    const key = getAnalysisKey(fileHash);
    const cached = await redis.get(key);

    if (cached) {
      console.log(`[Cache] Analysis cache HIT for hash ${fileHash.substring(0, 12)}...`);
      return parseCachedValue(cached);
    }

    console.log(`[Cache] Analysis cache MISS for hash ${fileHash.substring(0, 12)}...`);
    return null;
  } catch (error) {
    console.error('[Cache] Error getting analysis:', error.message);
    return null;
  }
}

/**
 * Merge and cache complete analysis (WinDBG + AI report)
 * @param {string} fileHash - The file or prompt content hash
 * @param {object} data - { windbgOutput, analysisSignalText, structured, aiReport }
 */
export async function setCachedAnalysis(fileHash, data) {
  if (!isCacheEnabled()) return false;

  try {
    const key = getAnalysisKey(fileHash);
    const existingValue = await redis.get(key);
    const existing = existingValue ? parseCachedValue(existingValue) : {};
    const cacheData = {
      ...existing,
      ...(data.windbgOutput !== undefined ? { windbgOutput: data.windbgOutput } : {}),
      ...(data.analysisSignalText !== undefined ? { analysisSignalText: data.analysisSignalText } : {}),
      ...(data.structured !== undefined ? { structured: data.structured } : {}),
      ...(data.aiReport !== undefined ? { aiReport: data.aiReport } : {}),
      timestamp: Date.now()
    };

    await redis.set(key, JSON.stringify(cacheData), { ex: CACHE_TTL_SECONDS });
    console.log(`[Cache] Analysis cached with hash ${fileHash.substring(0, 12)}... (TTL: 7d)`);
    return true;
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
