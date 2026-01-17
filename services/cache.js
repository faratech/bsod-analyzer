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

// No TTL - Upstash handles eviction automatically

// Initialize xxhash
let hasher = null;
xxhash().then(xxhashModule => {
  hasher = xxhashModule;
  console.log('[Cache] XXHash initialized for cache key generation');
});

// Cache key prefixes
const CACHE_PREFIX = {
  AI_REPORT: 'ai-report',
  WINDBG: 'windbg',
  FILE_HASH: 'file',
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

/**
 * Generate an xxhash64 hash of content for cache keys
 * Falls back to simple string hash if xxhash not yet initialized
 */
export function hashContent(content) {
  let data;
  if (typeof content === 'string') {
    data = content;
  } else if (Buffer.isBuffer(content)) {
    data = content.toString('binary');
  } else {
    data = JSON.stringify(content);
  }

  if (hasher) {
    return hasher.h64ToString(data);
  }

  // Fallback if xxhash not initialized yet (shouldn't happen in practice)
  console.warn('[Cache] XXHash not ready, using fallback hash');
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash) + data.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
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
 * Get cached AI report by WinDBG output hash
 * @param {string} windbgOutput - The WinDBG analysis text
 * @returns {Promise<object|null>} Cached report or null
 */
export async function getCachedAIReport(windbgOutput) {
  if (!isCacheEnabled()) return null;

  try {
    const hash = hashContent(windbgOutput);
    const key = getAIReportKey(hash);
    const cached = await redis.get(key);

    if (cached) {
      console.log(`[Cache] AI report cache HIT for hash ${hash.substring(0, 12)}...`);
      // Handle both string and object responses from Redis
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }

    console.log(`[Cache] AI report cache MISS for hash ${hash.substring(0, 12)}...`);
    return null;
  } catch (error) {
    console.error('[Cache] Error getting AI report:', error.message);
    return null;
  }
}

/**
 * Cache an AI report
 * @param {string} windbgOutput - The WinDBG analysis text (used for key)
 * @param {object} report - The AI-generated report to cache
 */
export async function setCachedAIReport(windbgOutput, report) {
  if (!isCacheEnabled()) return false;

  try {
    const hash = hashContent(windbgOutput);
    const key = getAIReportKey(hash);

    await redis.set(key, JSON.stringify(report));
    console.log(`[Cache] AI report cached with hash ${hash.substring(0, 12)}...`);
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
    const hash = Buffer.isBuffer(fileBuffer) ? hashContent(fileBuffer) : fileBuffer;
    const key = getWinDBGKey(hash);
    const cached = await redis.get(key);

    if (cached) {
      console.log(`[Cache] WinDBG analysis cache HIT for hash ${hash.substring(0, 12)}...`);
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }

    console.log(`[Cache] WinDBG analysis cache MISS for hash ${hash.substring(0, 12)}...`);
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

    await redis.set(key, JSON.stringify(analysisData));
    console.log(`[Cache] WinDBG analysis cached with hash ${hash.substring(0, 12)}...`);
    return true;
  } catch (error) {
    console.error('[Cache] Error caching WinDBG analysis:', error.message);
    return false;
  }
}

/**
 * Get cache statistics (for monitoring)
 */
export async function getCacheStats() {
  if (!isCacheEnabled()) {
    return { enabled: false };
  }

  try {
    // Upstash doesn't support INFO command via REST, so we return basic status
    return {
      enabled: true,
      connected: true,
    };
  } catch (error) {
    return {
      enabled: true,
      connected: false,
      error: error.message,
    };
  }
}

/**
 * Clear all cache entries (use with caution)
 * Only for admin/debugging purposes
 */
export async function clearCache() {
  if (!isCacheEnabled()) return false;

  try {
    // Upstash REST API doesn't support FLUSHALL
    // Would need to iterate and delete keys - not recommended for production
    console.warn('[Cache] Cache clear not supported via REST API');
    return false;
  } catch (error) {
    console.error('[Cache] Error clearing cache:', error.message);
    return false;
  }
}
