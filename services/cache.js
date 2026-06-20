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
import { HASH_HEX_RE, hashBytes, hashString, legacyHashBytes } from '../shared/hash.js';

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
  ANALYSIS: 'analysis',  // Combined WinDBG + AI report (new single-key approach)
  AI_REPORT: 'ai-report', // Legacy - kept for backwards compatibility
  WINDBG: 'windbg',       // Legacy - kept for backwards compatibility
  FILE_HASH: 'file',
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

function legacyHashContent(content) {
  if (!hasher) {
    throw new Error('XXHash not initialized');
  }

  if (Buffer.isBuffer(content)) {
    return legacyHashBytes(hasher, content);
  }
  return hashContent(content);
}

function cacheHashCandidates(cacheKey) {
  if (typeof cacheKey === 'string' && HASH_HEX_RE.test(cacheKey)) {
    return [cacheKey];
  }

  const primary = hashContent(cacheKey);
  if (!Buffer.isBuffer(cacheKey)) {
    return [primary];
  }

  const legacy = legacyHashContent(cacheKey);
  return legacy !== primary ? [primary, legacy] : [primary];
}

/**
 * Generate cache key for AI reports
 * Key is based on the WinDBG output hash since same analysis = same report
 */
function getAIReportKey(windbgOutputHash) {
  return `${CACHE_PREFIX.AI_REPORT}:${windbgOutputHash}`;
}

/**
 * Generate cache key for WinDBG analysis
 * Key is based on the dump file content hash
 */
function getWinDBGKey(fileHash) {
  return `${CACHE_PREFIX.WINDBG}:${fileHash}`;
}

/**
 * Get cached AI report by hash key
 * @param {string} cacheKey - The cache key (fileHash or content to hash)
 * @returns {Promise<object|null>} Cached report or null
 */
export async function getCachedAIReport(cacheKey) {
  if (!isCacheEnabled()) return null;

  try {
    const hashes = cacheHashCandidates(cacheKey);

    for (const hash of hashes) {
      const key = getAIReportKey(hash);
      const cached = await redis.get(key);

      if (cached) {
        console.log(`[Cache] AI report cache HIT for hash ${hash.substring(0, 12)}...`);
        // Handle both string and object responses from Redis
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    }

    console.log(`[Cache] AI report cache MISS for hash ${hashes[0].substring(0, 12)}...`);
    return null;
  } catch (error) {
    console.error('[Cache] Error getting AI report:', error.message);
    return null;
  }
}

/**
 * Cache an AI report
 * @param {string} cacheKey - The cache key (fileHash or content to hash)
 * @param {object} report - The AI-generated report to cache
 */
export async function setCachedAIReport(cacheKey, report) {
  if (!isCacheEnabled()) return false;

  try {
    // If cacheKey looks like a hash (16 hex chars), use it directly.
    const hash = (typeof cacheKey === 'string' && HASH_HEX_RE.test(cacheKey))
      ? cacheKey
      : hashContent(cacheKey);
    const key = getAIReportKey(hash);

    await redis.set(key, JSON.stringify(report), { ex: CACHE_TTL_SECONDS });
    console.log(`[Cache] AI report cached with hash ${hash.substring(0, 12)}... (TTL: 7d)`);
    return true;
  } catch (error) {
    console.error('[Cache] Error caching AI report:', error.message);
    return false;
  }
}

/**
 * Get cached WinDBG analysis by file hash
 * @param {Buffer|string} fileBuffer - The dump file content or its hash
 * @returns {Promise<object|null>} Cached analysis data or null
 */
export async function getCachedWinDBGAnalysis(fileBuffer) {
  if (!isCacheEnabled()) return null;

  try {
    const hashes = cacheHashCandidates(fileBuffer);

    for (const hash of hashes) {
      const key = getWinDBGKey(hash);
      const cached = await redis.get(key);

      if (cached) {
        const legacy = hash !== hashes[0] ? ' legacy' : '';
        console.log(`[Cache] WinDBG analysis${legacy} cache HIT for hash ${hash.substring(0, 12)}...`);
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    }

    console.log(`[Cache] WinDBG analysis cache MISS for hash ${hashes[0].substring(0, 12)}...`);
    return null;
  } catch (error) {
    console.error('[Cache] Error getting WinDBG analysis:', error.message);
    return null;
  }
}

/**
 * Cache WinDBG analysis result
 * @param {Buffer|string} fileBuffer - The dump file content or its hash
 * @param {object} analysisData - The analysis data to cache
 */
export async function setCachedWinDBGAnalysis(fileBuffer, analysisData) {
  if (!isCacheEnabled()) return false;

  try {
    const hash = Buffer.isBuffer(fileBuffer) ? hashContent(fileBuffer) : fileBuffer;
    const key = getWinDBGKey(hash);

    await redis.set(key, JSON.stringify(analysisData), { ex: CACHE_TTL_SECONDS });
    console.log(`[Cache] WinDBG analysis cached with hash ${hash.substring(0, 12)}... (TTL: 7d)`);
    return true;
  } catch (error) {
    console.error('[Cache] Error caching WinDBG analysis:', error.message);
    return false;
  }
}

// ============================================================
// Combined Analysis Cache (Single Key Approach)
// ============================================================

/**
 * Generate cache key for combined analysis
 * Key is based on the dump file content hash
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
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }

    // Fallback: Check legacy keys for backwards compatibility
    const [legacyWinDBG, legacyAI] = await Promise.all([
      getCachedWinDBGAnalysis(fileHash),
      getCachedAIReport(fileHash)
    ]);

    if (legacyWinDBG || legacyAI) {
      console.log(`[Cache] Legacy cache HIT for hash ${fileHash.substring(0, 12)}... (windbg: ${!!legacyWinDBG}, ai: ${!!legacyAI})`);
      return {
        windbgOutput: legacyWinDBG?.windbgOutput || null,
        windbgSignal: legacyWinDBG?.windbgSignal || legacyWinDBG?.analysisSignalText || null,
        analysisSignalText: legacyWinDBG?.analysisSignalText || legacyWinDBG?.windbgSignal || null,
        structured: legacyWinDBG?.structured || null,
        aiReport: legacyAI || null,
        timestamp: legacyWinDBG?.timestamp || Date.now(),
        legacy: true
      };
    }

    console.log(`[Cache] Analysis cache MISS for hash ${fileHash.substring(0, 12)}...`);
    return null;
  } catch (error) {
    console.error('[Cache] Error getting analysis:', error.message);
    return null;
  }
}

/**
 * Cache complete analysis (WinDBG + AI report)
 * @param {string} fileHash - The file content hash
 * @param {object} data - { windbgOutput, aiReport }
 */
export async function setCachedAnalysis(fileHash, data) {
  if (!isCacheEnabled()) return false;

  try {
    const key = getAnalysisKey(fileHash);
    const cacheData = {
      windbgOutput: data.windbgOutput,
      aiReport: data.aiReport,
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
