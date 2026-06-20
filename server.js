import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GoogleGenAI } from '@google/genai';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import crypto from 'crypto';
import xxhash from 'xxhash-wasm';
import { SECURITY_CONFIG } from './serverConfig.js';
import { PROMPT_SHAPES, SYSTEM_INSTRUCTION_ANALYSIS, WINDBG_PREFIX, WINDBG_OUTPUT_MARKER, wrapWithEvidence } from './shared/promptTemplates.js';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import JSZip from 'jszip';
import net from 'net';
import {
  ALLOWED_EXTENSIONS,
  DUMP_EXTENSIONS,
  FILE_LIMITS,
  detectArchiveType,
  getFileExtension,
  sanitizeUploadFileName,
  validatePathEntry,
  validateUploadedBuffer
} from './shared/ingestPolicy.js';
import {
  DEFAULT_WINDBG_API_BASE_URL,
  extractWinDbgAnalysisPackage,
  getWinDbgJob,
  normalizeWinDbgApiBaseUrl,
  submitWinDbgJob,
  toLegacyWinDbgStatusResponse
} from './shared/windbgApiClient.js';
import {
  createFastifyCompatApp,
  jsonParser,
  staticMiddleware
} from './server/fastifyCompat.js';
import {
  createRateLimiterFactory,
  jsonRateLimitHandler,
  normalizeRateLimitIp
} from './server/rateLimit.js';
import { createUploadHandler } from './server/uploadHandler.js';

const execFileAsync = promisify(execFile);
import {
  initCache,
  initHashing,
  hashContent,
  getCachedAIReport,
  setCachedAIReport,
  getCachedWinDBGAnalysis,
  setCachedWinDBGAnalysis,
  getCachedAnalysis,
  isAnalysisCached,
  getRuntimeValue,
  setRuntimeValue,
  deleteRuntimeValue,
  isCacheEnabled,
  checkCacheConnection,
  incrementRuntimeCounter
} from './services/cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Structured logging
// Cloud Run auto-parses any JSON line on stdout into Cloud Logging's jsonPayload
// and reads `severity` as the log level. Querying `jsonPayload.event="..."`
// then lets us chart metrics (cache hit rate, token spend, WinDBG failures)
// directly from the log stream — no separate metrics pipeline needed.
// ---------------------------------------------------------------------------
function emitJsonLog(severity, event, fields) {
  try {
    process.stdout.write(JSON.stringify({ severity, event, ...fields }) + '\n');
  } catch {
    // Fallback if a field contains a cycle or BigInt.
    process.stdout.write(JSON.stringify({ severity, event, message: 'log serialization failed' }) + '\n');
  }
}
const log = {
  info:  (event, fields = {}) => emitJsonLog('INFO',    event, fields),
  warn:  (event, fields = {}) => emitJsonLog('WARNING', event, fields),
  error: (event, fields = {}) => emitJsonLog('ERROR',   event, fields),
};

const PORT = process.env.PORT || 8080;

// Trust proxy headers (required for Cloud Run). With Cloudflare in front of
// Cloud Run, the X-Forwarded-For chain is [user-ip, cloudflare-edge-ip] as the
// platform appends its view of the connecting peer. TRUST_PROXY_HOPS defaults
// to 2 to walk past both hops.
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS || '2', 10);
const TRUST_PROXY_VALUE = Number.isFinite(TRUST_PROXY_HOPS) ? TRUST_PROXY_HOPS : 2;
const app = createFastifyCompatApp({
  trustProxy: TRUST_PROXY_VALUE,
  bodyLimit: SECURITY_CONFIG.api.maxUploadRequestSize,
  compression: {
    enabled: true,
    threshold: 1024,
    forceThreshold: 0,
    forceEncoding: req => isFromCloudflare(req) ? 'zstd' : null
  }
});
app.set('trust proxy', TRUST_PROXY_VALUE);

const MAX_RAW_FILE_SIZE = SECURITY_CONFIG.api.maxRawFileSize;
const MAX_UPLOAD_REQUEST_SIZE = SECURITY_CONFIG.api.maxUploadRequestSize;
const MAX_EXTRACTED_ARCHIVE_SIZE = SECURITY_CONFIG.api.maxExtractedArchiveSize;
const MAX_ARCHIVE_FILE_COUNT = FILE_LIMITS.maxArchiveFileCount;
const MAX_ARCHIVE_COMPRESSION_RATIO = FILE_LIMITS.maxCompressionRatio;
const HASH_RE = /^[a-f0-9]{8,16}$/i;
const TURNSTILE_ACTION = process.env.TURNSTILE_ACTION || 'file-upload';
const AI_MAX_PROMPT_CHARS = readPositiveInt(process.env.AI_MAX_PROMPT_CHARS, 250_000);
const GEMINI_TIMEOUT_MS = readPositiveInt(process.env.GEMINI_TIMEOUT_MS, 60_000);
const TURNSTILE_TIMEOUT_MS = readPositiveInt(process.env.TURNSTILE_TIMEOUT_MS, 10_000);
const WINDBG_UPLOAD_TIMEOUT_MS = readPositiveInt(process.env.WINDBG_UPLOAD_TIMEOUT_MS, 120_000);
const WINDBG_POLL_TIMEOUT_MS = readPositiveInt(process.env.WINDBG_POLL_TIMEOUT_MS, 20_000);
const WINDBG_DOWNLOAD_TIMEOUT_MS = readPositiveInt(process.env.WINDBG_DOWNLOAD_TIMEOUT_MS, 60_000);
// The JSON output contract is now part of the cache-stable prefixes in
// shared/promptTemplates.js (LOCAL_DUMP_PREFIX / WINDBG_PREFIX), so it no
// longer needs to be appended after the dynamic evidence.

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function withTimeout(operation, ms, message) {
  let timeoutHandle;
  const operationPromise = Promise.resolve().then(operation);
  operationPromise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Cloudflare-published IP ranges (https://www.cloudflare.com/ips/).
// Refresh manually when Cloudflare announces changes; the lists are stable
// for months at a time.
const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const cloudflareBlockList = new net.BlockList();
for (const range of CLOUDFLARE_IPV4_RANGES) {
  const [addr, prefix] = range.split('/');
  cloudflareBlockList.addSubnet(addr, Number(prefix), 'ipv4');
}
for (const range of CLOUDFLARE_IPV6_RANGES) {
  const [addr, prefix] = range.split('/');
  cloudflareBlockList.addSubnet(addr, Number(prefix), 'ipv6');
}

// Returns the IP that Cloud Run saw connecting to the service. Cloud Run
// appends its view of the peer IP to X-Forwarded-For, so the rightmost entry
// is the immediate upstream — which is a Cloudflare edge IP in production.
function getImmediatePeerIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || null;
}

function isFromCloudflare(req) {
  const ip = getImmediatePeerIp(req);
  if (!ip) return false;
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(normalized)) return cloudflareBlockList.check(normalized, 'ipv4');
  if (net.isIPv6(normalized)) return cloudflareBlockList.check(normalized, 'ipv6');
  return false;
}

// CF-Connecting-IP is set by Cloudflare and contains the original client IP.
// Trust it only when the immediate peer is a Cloudflare edge; otherwise fall
// back to Fastify's trusted-proxy IP calculation.
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0 && isFromCloudflare(req)) return cfIp;
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// Reject any request whose immediate peer is not a Cloudflare edge IP.
// Combined with --no-default-url on the Cloud Run service, this closes both
// the default *.run.app URL and any direct-Cloud-Run path. /health is exempt
// so Cloud Run's own probes (which arrive without X-Forwarded-For) still pass.
const CLOUDFLARE_ONLY_INGRESS =
  (process.env.CLOUDFLARE_ONLY_INGRESS ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
if (CLOUDFLARE_ONLY_INGRESS) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (isFromCloudflare(req)) return next();
    log.warn('non_cloudflare_request_rejected', {
      path: req.path,
      peer: getImmediatePeerIp(req),
      xff: req.headers['x-forwarded-for'] || null,
    });
    return res.status(403).send('Forbidden');
  });
}

function rateLimitKey(req) {
  return normalizeRateLimitIp(getClientIp(req));
}

const makeLimiter = createRateLimiterFactory({
  isCacheEnabled,
  incrementRuntimeCounter,
  deleteRuntimeValue,
  defaultKeyGenerator: rateLimitKey,
  defaultHandler: jsonRateLimitHandler
});

function createConcurrencyLimiter(max, code) {
  let active = 0;
  return (req, res, next) => {
    if (active >= max) {
      return res.status(429).json({
        success: false,
        error: 'Server is busy. Please retry shortly.',
        code
      });
    }

    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active = Math.max(0, active - 1);
      }
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

function rejectLargeBody(limitBytes) {
  return (req, res, next) => {
    const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > limitBytes) {
      return res.status(413).json({
        success: false,
        error: `Request too large. Maximum size is ${(limitBytes / 1024 / 1024).toFixed(0)}MB`,
        code: 'REQUEST_TOO_LARGE'
      });
    }
    next();
  };
}

function safeToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function timingSafeEqualString(a, b) {
  const aHash = crypto.createHash('sha256').update(String(a || '')).digest();
  const bHash = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

// Initialize xxhash (awaited before server starts listening)
let hasher;

// Initialize Upstash Redis cache
initCache();
const REQUIRE_REDIS_RUNTIME =
  (process.env.REQUIRE_REDIS_RUNTIME ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';

// Secret for session validation
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET must be configured in production.');
    process.exit(1);
  }
}
// Use the secret (either from env or temporary)
const ACTUAL_SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Store valid sessions. Redis is the source of truth across Cloud Run
// instances; these maps are just per-instance hot caches.
const validSessions = new Map(); // sessionId -> { hash, timestamp, turnstileVerified }
const SESSION_EXPIRY = 60 * 60 * 1000; // 1 hour
const SESSION_EXPIRY_SECONDS = Math.ceil(SESSION_EXPIRY / 1000);

// Track API requests per session (prevent rapid abuse)
const sessionRequestTracking = new Map(); // sessionId -> { count, resetTime, totalTokens }
const REQUEST_LIMIT_PER_SESSION = 50; // Max 50 requests per hour per session
// totalTokens now accumulates input + output (prior code added only output). Per-request input
// dropped ~5x with the prompt/size-cap changes, so 50 × typical ~6K = ~300K, well under this cap.
const TOKEN_LIMIT_PER_SESSION = 500000; // Max ~500K tokens per hour per session

// Track which hashes/jobs were proven by a session uploading the corresponding file.
const sessionHashOwnership = new Map(); // sessionId -> Map(hash -> timestamp)
const winDbgJobOwnership = new Map(); // uid -> { sessionId, fileHash, timestamp }
const OWNERSHIP_EXPIRY = SESSION_EXPIRY;
const OWNERSHIP_EXPIRY_SECONDS = Math.ceil(OWNERSHIP_EXPIRY / 1000);

// Track external asynchronous analysis jobs (fallback when Redis is not enabled)
const externalJobs = new Map(); // uid -> jobData
const JOB_EXPIRY_SECONDS = 30 * 60; // 30 minutes

async function storeJob(uid, jobData) {
  if (isCacheEnabled()) {
    const stored = await setRuntimeValue(`job:${uid}`, jobData, JOB_EXPIRY_SECONDS);
    if (!stored && REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store unavailable while saving analysis job');
    }
  } else {
    if (REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store required but Redis cache is not configured');
    }
    externalJobs.set(uid, jobData);
  }
}

async function loadJob(uid) {
  if (isCacheEnabled()) {
    return await getRuntimeValue(`job:${uid}`);
  }
  return externalJobs.get(uid);
}

function runtimeSessionKey(sessionId) {
  return `session:${sessionId}`;
}

function runtimeSessionHashKey(sessionId, hash) {
  return `session-hash:${sessionId}:${hash}`;
}

function runtimeWinDbgJobKey(uid) {
  return `windbg-job:${uid}`;
}

function runtimeSessionTrackingKey(sessionId) {
  return `session-tracking:${sessionId}`;
}

async function storeSession(sessionId, sessionData) {
  if (isCacheEnabled()) {
    const stored = await setRuntimeValue(runtimeSessionKey(sessionId), sessionData, SESSION_EXPIRY_SECONDS);
    if (!stored && REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store unavailable while saving session');
    }
  } else {
    if (REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store required but Redis cache is not configured');
    }
    validSessions.set(sessionId, sessionData);
  }
}

async function loadSessionTracking(sessionId) {
  if (isCacheEnabled()) {
    return await getRuntimeValue(runtimeSessionTrackingKey(sessionId));
  }
  return sessionRequestTracking.get(sessionId);
}

async function storeSessionTracking(sessionId, tracking) {
  if (isCacheEnabled()) {
    const ttlSeconds = Math.max(1, Math.ceil((tracking.resetTime - Date.now()) / 1000));
    const stored = await setRuntimeValue(runtimeSessionTrackingKey(sessionId), tracking, ttlSeconds);
    if (!stored && REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store unavailable while saving session quota');
    }
  } else {
    if (REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store required but Redis cache is not configured');
    }
    sessionRequestTracking.set(sessionId, tracking);
  }
}

async function loadSession(sessionId) {
  if (isCacheEnabled()) {
    return await getRuntimeValue(runtimeSessionKey(sessionId));
  }
  return validSessions.get(sessionId);
}

async function deleteSession(sessionId) {
  if (isCacheEnabled()) {
    await deleteRuntimeValue(runtimeSessionKey(sessionId));
  } else {
    validSessions.delete(sessionId);
  }
  sessionHashOwnership.delete(sessionId);
}

async function markSessionHash(sessionId, hash) {
  if (!sessionId || !hash || !HASH_RE.test(hash)) return;
  let hashes = sessionHashOwnership.get(sessionId);
  if (!hashes) {
    hashes = new Map();
    sessionHashOwnership.set(sessionId, hashes);
  }
  const timestamp = Date.now();
  hashes.set(hash, timestamp);
  if (isCacheEnabled()) {
    const stored = await setRuntimeValue(runtimeSessionHashKey(sessionId, hash), { timestamp }, OWNERSHIP_EXPIRY_SECONDS);
    if (!stored && REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store unavailable while saving file ownership');
    }
  }
}

async function sessionOwnsHash(sessionId, hash) {
  const hashes = sessionHashOwnership.get(sessionId);
  if (hashes?.has(hash)) {
    if (Date.now() - hashes.get(hash) > OWNERSHIP_EXPIRY) {
      hashes.delete(hash);
      await deleteRuntimeValue(runtimeSessionHashKey(sessionId, hash));
      return false;
    }
    return true;
  }

  const stored = await getRuntimeValue(runtimeSessionHashKey(sessionId, hash));
  if (!stored?.timestamp || Date.now() - stored.timestamp > OWNERSHIP_EXPIRY) {
    await deleteRuntimeValue(runtimeSessionHashKey(sessionId, hash));
    return false;
  }

  let sessionHashes = sessionHashOwnership.get(sessionId);
  if (!sessionHashes) {
    sessionHashes = new Map();
    sessionHashOwnership.set(sessionId, sessionHashes);
  }
  sessionHashes.set(hash, stored.timestamp);
  return true;
}

async function markWinDbgJob(sessionId, uid, fileHash, upstreamJobId = uid) {
  if (!sessionId || !uid || !fileHash) return;
  const ownership = { sessionId, fileHash, upstreamJobId, timestamp: Date.now() };
  winDbgJobOwnership.set(uid, ownership);
  if (isCacheEnabled()) {
    const stored = await setRuntimeValue(runtimeWinDbgJobKey(uid), ownership, OWNERSHIP_EXPIRY_SECONDS);
    if (!stored && REQUIRE_REDIS_RUNTIME) {
      throw new Error('Runtime store unavailable while saving WinDBG job ownership');
    }
  }
  await markSessionHash(sessionId, fileHash);
}

async function loadWinDbgJobOwnership(uid) {
  let job = winDbgJobOwnership.get(uid);
  if (!job) {
    job = await getRuntimeValue(runtimeWinDbgJobKey(uid));
    if (job) winDbgJobOwnership.set(uid, job);
  }
  return job;
}

async function getOwnedWinDbgJob(sessionId, uid) {
  const job = await loadWinDbgJobOwnership(uid);
  if (!job || job.sessionId !== sessionId) return null;
  if (Date.now() - job.timestamp > OWNERSHIP_EXPIRY) {
    winDbgJobOwnership.delete(uid);
    await deleteRuntimeValue(runtimeWinDbgJobKey(uid));
    return null;
  }
  return job;
}

// ============================================================
// External API Key Authentication
// ============================================================
const BSOD_API_KEY = process.env.BSOD_API_KEY;
if (!BSOD_API_KEY) {
  console.warn('WARNING: BSOD_API_KEY not configured - external API access disabled');
}

// Fastify multipart upload compatibility for existing handlers.
const upload = createUploadHandler({
  limits: {
    fileSize: MAX_RAW_FILE_SIZE,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    // Accept dump files and archives
    const ext = getFileExtension(file.originalname);
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
  }
});

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of validSessions.entries()) {
    if (now - data.timestamp > SESSION_EXPIRY) {
      validSessions.delete(sessionId);
      sessionHashOwnership.delete(sessionId);
    }
  }
  for (const [sessionId, tracking] of sessionRequestTracking.entries()) {
    if (now > tracking.resetTime) {
      sessionRequestTracking.delete(sessionId);
    }
  }
  for (const [uid, job] of externalJobs.entries()) {
    if (now - job.timestamp > JOB_EXPIRY_SECONDS * 1000) {
      externalJobs.delete(uid);
    }
  }
  for (const [sessionId, hashes] of sessionHashOwnership.entries()) {
    for (const [hash, timestamp] of hashes.entries()) {
      if (now - timestamp > OWNERSHIP_EXPIRY) hashes.delete(hash);
    }
    if (hashes.size === 0) sessionHashOwnership.delete(sessionId);
  }
  for (const [uid, data] of winDbgJobOwnership.entries()) {
    if (now - data.timestamp > OWNERSHIP_EXPIRY) winDbgJobOwnership.delete(uid);
  }
}, 10 * 60 * 1000); // Clean every 10 minutes

// Gemini model selection.
// - getPrimaryModel() re-reads model.cfg per call with a 30s cache so the model can
//   be swapped without a redeploy (edit model.cfg in the running container / overlay).
// - FALLBACK_MODEL is a prior-generation stable flash-lite kept as a safety net in case
//   the primary model 404s or is throttled — generateWithFallback() catches that and retries.
const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
const MODEL_CFG_PATH = path.join(__dirname, 'model.cfg');
const MODEL_CFG_TTL_MS = 30_000;
let _modelCfgCache = { value: 'gemini-3.1-flash-lite', readAt: 0 };

function getPrimaryModel() {
  const now = Date.now();
  if (now - _modelCfgCache.readAt >= MODEL_CFG_TTL_MS) {
    // Trigger background read so we do not block the Node event loop
    _modelCfgCache.readAt = now;
    fs.promises.readFile(MODEL_CFG_PATH, 'utf8')
      .then(modelConfig => {
        const cleaned = modelConfig.trim();
        if (cleaned) {
          _modelCfgCache.value = cleaned;
        }
      })
      .catch(() => {
        // Keep last-good value on error
      });
  }
  return _modelCfgCache.value;
}

// Prime once at startup so the existing startup log is meaningful.
const DEFAULT_MODEL_NAME = getPrimaryModel();
log.info('gemini.startup', { primary: DEFAULT_MODEL_NAME, fallback: FALLBACK_MODEL });

// Recognise the error shapes Gemini returns when a model is missing / preview-pulled.
function isModelUnavailableError(err) {
  const msg = (err?.message || '') + ' ' + (err?.status || '');
  return /\bNOT_FOUND\b|\b404\b|is not found for API version|UNIMPLEMENTED/i.test(msg);
}

// Wrap any ai.models.generateContent(request) call so that if the configured primary
// model is unavailable, we transparently retry against the stable fallback.
async function generateWithFallback(request) {
  try {
    return await withTimeout(
      () => genAI.models.generateContent(request),
      GEMINI_TIMEOUT_MS,
      'Gemini request timed out'
    );
  } catch (err) {
    if (!isModelUnavailableError(err) || request.model === FALLBACK_MODEL) throw err;
    log.warn('gemini.model.fallback', {
      primary: request.model,
      fallback: FALLBACK_MODEL,
      reason: err.message?.slice(0, 200)
    });
    return await withTimeout(
      () => genAI.models.generateContent({ ...request, model: FALLBACK_MODEL }),
      GEMINI_TIMEOUT_MS,
      'Gemini fallback request timed out'
    );
  }
}

// Configure CORS with Cloud Run best practices
const corsOptions = {
  origin: function (origin, callback) {
    // Important: Allow requests with no origin (same-origin, server-side, curl, etc.)
    // This is safe and necessary for Cloud Run
    if (!origin) {
      return callback(null, true);
    }
    
    // Allow file:// only during local development.
    if (process.env.NODE_ENV !== 'production' && origin.startsWith('file://')) {
      return callback(null, true);
    }
    
    // Build allowed origins based on environment
    const allowedOrigins = [];
    
    if (process.env.NODE_ENV !== 'production') {
      // Development origins
      allowedOrigins.push(
        'http://localhost:5173', // Vite dev server
        'http://localhost:8080', // Local server
        'http://localhost:3000'  // Common React dev port
      );
    }
    
    // Production origins from environment
    if (process.env.PRODUCTION_URL) {
      allowedOrigins.push(process.env.PRODUCTION_URL);
    }
    if (process.env.ALLOWED_ORIGINS) {
      // Support comma-separated list
      allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()));
    }
    
    // Default production origins
    allowedOrigins.push('https://bsod.windowsforum.com');

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400, // Cache preflight for 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Fastify plugins
app.fastify.register(fastifyCors, corsOptions);
app.fastify.register(fastifyCookie);
app.fastify.register(fastifyMultipart, {
  limits: {
    fileSize: MAX_RAW_FILE_SIZE,
    files: 1,
    fields: 20,
    parts: 25
  }
});

// Rate limiting middleware
const apiLimiter = makeLimiter({
  windowMs: SECURITY_CONFIG.api.rateLimiting.windowMs,
  max: SECURITY_CONFIG.api.rateLimiting.maxRequests,
  keyGenerator: rateLimitKey,
  handler: jsonRateLimitHandler,
  name: 'api',
  skip: (req) => {
    // Skip rate limiting for health check endpoint
    return req.path === '/health';
  }
});

const authLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 20, name: 'auth' });
const cacheLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 120, name: 'cache' });
const geminiLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 40, name: 'gemini' });
const windbgUploadLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20, name: 'windbg-upload' });
const windbgPollLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 300, name: 'windbg-poll' });
const archiveLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 10, name: 'archive' });
const externalAnalyzeLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: 'external-analyze',
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'];
    return apiKey ? `api:${safeToken(apiKey)}` : `ip:${rateLimitKey(req)}`;
  }
});

const geminiConcurrency = createConcurrencyLimiter(8, 'AI_BUSY');
const windbgUploadConcurrency = createConcurrencyLimiter(2, 'WINDBG_UPLOAD_BUSY');
const archiveConcurrency = createConcurrencyLimiter(2, 'ARCHIVE_BUSY');
const externalAnalyzeConcurrency = createConcurrencyLimiter(2, 'ANALYSIS_BUSY');

// Higher limit parser for file upload endpoints (base64-encoded files can be up to 133MB for 100MB files)
const largeJsonParser = jsonParser({ limit: `${Math.ceil(MAX_UPLOAD_REQUEST_SIZE / 1024 / 1024)}mb` });

// Default JSON parser applied per-route, after rate limit and requireSession,
// so unauthenticated requests are rejected before allocating a parse buffer.
const defaultJsonParser = jsonParser({ limit: `${Math.ceil(SECURITY_CONFIG.api.maxRequestSize / 1024 / 1024)}mb` });

// Precompute CSP header string once at startup (avoids rebuilding on every request)
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://*.cloudflare.com https://static.cloudflareinsights.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://adnxs.com https://www.paypalobjects.com",
  // AdSense's adsbygoogle.js runtime injects a small container-sizing stylesheet
  // as a data:text/css URL, so 'data:' is required here for ad slots to render.
  "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://*.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.gstatic.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://generativelanguage.googleapis.com https://www.paypal.com",
  "frame-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://www.paypal.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.paypal.com",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests"
].join('; ');

// Global security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// MIME type lookup for static assets
const MIME_TYPES = {
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Set MIME types for assets BEFORE any other middleware
// Ensures Cloud Run serves files with correct Content-Type
app.use((req, res, next) => {
  if (req.path.startsWith('/assets/')) {
    const ext = path.extname(req.path).toLowerCase();
    const mime = MIME_TYPES[ext];
    if (mime) res.type(mime);
  }
  next();
});

// Security middleware - block access to sensitive paths
app.use((req, res, next) => {
  const blockedPaths = [
    '/public',
    '/src',
    '/components',
    '/pages',
    '/services',
    '/hooks',
    '/types',
    '/node_modules',
    '/.git',
    '/.env'
  ];

  const blockedExtensions = [
    '.ts',
    '.tsx',
    '.js.map',
    '.css.map',
    '.log',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    '.env'
  ];

  // Block access to sensitive directories
  if (blockedPaths.some(path => req.path.startsWith(path))) {
    return res.status(403).send('Access Denied');
  }

  // Block access to sensitive file types
  if (blockedExtensions.some(ext => req.path.endsWith(ext))) {
    return res.status(403).send('Access Denied');
  }

  next();
});

// Static file serving with MIME types and caching via shared lookup
const TEXT_EXTS = new Set(['.js', '.mjs', '.css', '.html', '.json']);
const NOSNIFF_EXTS = new Set(['.js', '.mjs', '.css', '.html']);
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);

app.use(staticMiddleware(path.join(__dirname, 'dist'), {
  maxAge: '1y',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext];

    if (mime) {
      res.setHeader('Content-Type', TEXT_EXTS.has(ext) ? `${mime}; charset=utf-8` : mime);
    }
    if (NOSNIFF_EXTS.has(ext)) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // Cache strategy
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=0');
    } else if (ext === '.html') {
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
    } else if (ext === '.json') {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (filePath.includes('/symbols/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
    } else if (mime) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }

    // CORS for fonts
    if (FONT_EXTS.has(ext)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
}));

// Validate Gemini API key at startup
if (!process.env.GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY not configured - AI analysis will not work');
  // Don't exit in production - allow service to start but AI features will be disabled
}

// Initialize Gemini AI with server-side API key
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// Turnstile secret key from environment/Secret Manager
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

// Store used tokens to prevent replay attacks
const usedTurnstileTokens = new Map(); // token -> timestamp

// Clean up old tokens periodically (older than 5 minutes)
setInterval(() => {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  for (const [token, timestamp] of usedTurnstileTokens.entries()) {
    if (timestamp < fiveMinutesAgo) {
      usedTurnstileTokens.delete(token);
    }
  }
}, 60 * 1000); // Clean every minute

// Verify Turnstile token with proper Siteverify implementation
async function verifyTurnstileToken(token, ip, idempotencyKey = null) {
  if (!TURNSTILE_SECRET_KEY) {
    console.error('TURNSTILE_SECRET_KEY not configured');
    return { 
      success: false, 
      'error-codes': ['missing-input-secret'],
      error: 'Turnstile not configured' 
    };
  }

  if (!token || typeof token !== 'string' || token.length > 4096) {
    return { 
      success: false, 
      'error-codes': ['missing-input-response'],
      error: 'No token provided' 
    };
  }

  // Check if token was already used (prevent replay attacks)
  if (usedTurnstileTokens.has(token)) {
    console.warn('Turnstile token replay blocked:', safeToken(token));
    return { 
      success: false, 
      'error-codes': ['timeout-or-duplicate'],
      error: 'Token already used' 
    };
  }

  try {
    // Build form data as required by Siteverify API
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token); // Must be called 'response', not 'token'
    
    if (ip) {
      formData.append('remoteip', ip);
    }
    
    // Add idempotency key for retry support
    if (idempotencyKey) {
      formData.append('idempotency_key', idempotencyKey);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData,
      signal: timeoutSignal(TURNSTILE_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.error('Siteverify HTTP error:', response.status);
      return { 
        success: false, 
        'error-codes': ['internal-error'],
        error: 'Siteverify request failed' 
      };
    }

    const result = await response.json();
    
    if (result.success) {
      // Mark token as used to prevent replay attacks
      usedTurnstileTokens.set(token, Date.now());
      
      // Log successful verification
      console.log('Turnstile verification successful:', {
        hostname: result.hostname,
        challenge_ts: result.challenge_ts,
        action: result.action
      });
    } else {
      console.error('Turnstile verification failed:', result['error-codes']);
    }
    
    return result;
  } catch (error) {
    console.error('Turnstile Siteverify error:', error);
    return { 
      success: false, 
      'error-codes': ['internal-error'],
      error: 'Verification request failed' 
    };
  }
}

// Generate session cookie. Keep xxhash signing, but do not bind the session to
// the observed request IP: Cloudflare may send successive browser requests
// through different edge IPs, which would invalidate legitimate long polls.
function generateSessionCookie(turnstileVerified = false) {
  if (!hasher) {
    console.error('XXHash not initialized when trying to generate session');
    throw new Error('XXHash not initialized');
  }
  
  const sessionId = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const dataToHash = `${sessionId}:${timestamp}:${ACTUAL_SESSION_SECRET}`;
  const sessionHash = hasher.h64ToString(dataToHash);
  const sessionData = {
    hash: sessionHash,
    timestamp,
    turnstileVerified
  };
  if (!isCacheEnabled()) {
    validSessions.set(sessionId, sessionData);
  }
  
  return {
    sessionId,
    sessionHash,
    sessionData
  };
}

// Set session cookies on a response
function setSessionCookies(res, sessionId, sessionHash) {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_EXPIRY,
    path: '/',
  };
  res.cookie('bsod_session_id', sessionId, cookieOptions);
  res.cookie('bsod_session_hash', sessionHash, cookieOptions);
  return cookieOptions;
}

function clearSessionCookies(res) {
  const baseOptions = {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };

  res.clearCookie('bsod_session_id', { ...baseOptions, httpOnly: true });
  res.clearCookie('bsod_session_hash', { ...baseOptions, httpOnly: true });
  res.clearCookie('bsod_turnstile_verified', { ...baseOptions, httpOnly: false });
}

// Validate session cookie
async function validateSession(sessionId, sessionHash) {
  const sessionData = await loadSession(sessionId);
  
  if (!sessionData) {
    return { valid: false, reason: 'Session not found' };
  }
  
  // Check expiry
  if (Date.now() - sessionData.timestamp > SESSION_EXPIRY) {
    await deleteSession(sessionId);
    return { valid: false, reason: 'Session expired' };
  }
  
  // Verify hash
  if (sessionData.hash !== sessionHash) {
    return { valid: false, reason: 'Invalid session hash' };
  }
  
  return { valid: true, sessionData };
}

// Middleware to validate session for analyzer API
const requireSession = async (req, res, next) => {
  const sessionId = req.cookies.bsod_session_id;
  const sessionHash = req.cookies.bsod_session_hash;
  const clientIp = getClientIp(req);

  try {
    // In development mode, skip validation
    if (process.env.NODE_ENV === 'development') {
      return next();
    }

    if (!sessionId || !sessionHash) {
      console.log('Session validation failed - missing cookies:', {
        sessionId: !!sessionId,
        sessionHash: !!sessionHash,
        cookies: Object.keys(req.cookies || {})
      });
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Session required', code: 'NO_SESSION' });
    }

    const validation = await validateSession(sessionId, sessionHash);
    if (!validation.valid) {
      console.log('Session validation failed:', {
        reason: validation.reason,
        sessionId: sessionId.substring(0, 10) + '...',
        clientIp
      });
      if (validation.reason === 'Session not found' || validation.reason === 'Session expired') {
        clearSessionCookies(res);
        return res.status(401).json({
          error: 'Turnstile verification required',
          code: 'TURNSTILE_REQUIRED'
        });
      }
      return res.status(401).json({ error: validation.reason, code: 'INVALID_SESSION' });
    }
    if (!validation.sessionData?.turnstileVerified) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Turnstile verification required', code: 'TURNSTILE_REQUIRED' });
    }

    const sessionData = validation.sessionData;
    sessionData.timestamp = Date.now();
    await storeSession(sessionId, sessionData);

    req.sessionId = sessionId;
    req.sessionData = sessionData;
    req.clientIp = clientIp;

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to validate API key for external service access
const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!BSOD_API_KEY) {
    console.log('[API Auth] External API access not configured');
    return res.status(503).json({
      success: false,
      error: 'External API access not configured',
      code: 'API_NOT_CONFIGURED'
    });
  }

  if (!apiKey) {
    console.log('[API Auth] Missing API key in request');
    return res.status(401).json({
      success: false,
      error: 'API key required',
      code: 'NO_API_KEY'
    });
  }

  if (typeof apiKey !== 'string' || !timingSafeEqualString(apiKey, BSOD_API_KEY)) {
    console.log('[API Auth] Invalid API key provided');
    return res.status(401).json({
      success: false,
      error: 'Invalid API key',
      code: 'INVALID_API_KEY'
    });
  }

  // Mark request as API-authenticated (for logging)
  req.isApiAuthenticated = true;
  console.log('[API Auth] External API request authenticated');
  next();
};

// Health check endpoint for Cloud Run (not rate limited)
app.get('/health', async (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Apply rate limiting to API endpoints
app.use('/api/', apiLimiter);

// Endpoint to verify Turnstile and create session
app.post('/api/auth/verify-turnstile', authLimiter, defaultJsonParser, async (req, res) => {
  try {
    const { token, action } = req.body;
    const clientIp = getClientIp(req);
    
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' &&
      /^[a-f0-9-]{16,64}$/i.test(req.body.idempotencyKey)
      ? req.body.idempotencyKey
      : null;
    
    // Verify the Turnstile token with Siteverify
    const verification = await verifyTurnstileToken(token, clientIp, idempotencyKey);
    
    if (!verification.success) {
      // Log detailed error for debugging
      console.error('Turnstile Siteverify failed:', {
        'error-codes': verification['error-codes'],
        clientIp,
        tokenHash: token ? safeToken(token) : 'none'
      });
      
      // Return appropriate error based on error codes
      const errorCode = verification['error-codes']?.[0] || 'unknown-error';
      let userMessage = 'Security verification failed';
      
      switch (errorCode) {
        case 'missing-input-response':
          userMessage = 'Security token missing';
          break;
        case 'invalid-input-response':
          userMessage = 'Security token invalid or expired';
          break;
        case 'timeout-or-duplicate':
          userMessage = 'Security token already used or expired';
          break;
        case 'invalid-input-secret':
          userMessage = 'Server configuration error';
          break;
      }
      
      return res.status(400).json({ 
        success: false, 
        error: userMessage,
        'error-codes': verification['error-codes']
      });
    }
    
    // Validate expected action.
    if (action !== TURNSTILE_ACTION || verification.action !== TURNSTILE_ACTION) {
      console.warn('Turnstile action mismatch:', {
        expected: TURNSTILE_ACTION,
        requested: action,
        received: verification.action
      });
      return res.status(400).json({
        success: false,
        error: 'Security verification action mismatch',
        code: 'TURNSTILE_ACTION_MISMATCH'
      });
    }
    
    // Validate hostname matches expected domain
    const expectedHostnames = [
      ...(process.env.NODE_ENV === 'production' ? [] : ['localhost']),
      'bsod.windowsforum.com',
      ...(process.env.ALLOWED_TURNSTILE_HOSTNAMES || process.env.ALLOWED_HOSTNAME || '')
        .split(',')
        .map(host => host.trim())
        .filter(Boolean)
    ];
    
    if (verification.hostname && !expectedHostnames.includes(verification.hostname)) {
      console.warn('Unexpected hostname in Turnstile response:', verification.hostname);
      return res.status(400).json({
        success: false,
        error: 'Security verification hostname mismatch',
        code: 'TURNSTILE_HOSTNAME_MISMATCH'
      });
    }
    
    // If verification successful, create session
    const { sessionId, sessionHash, sessionData } = generateSessionCookie(true);
    await storeSession(sessionId, sessionData);

    const cookieOptions = setSessionCookies(res, sessionId, sessionHash);
    res.cookie('bsod_turnstile_verified', 'true', {
      ...cookieOptions,
      httpOnly: false,
      maxAge: 2 * 60 * 60 * 1000
    }); // UI hint only; server authorization still requires the signed session cookies.
    
    // Return success with verification details
    res.json({ 
      success: true,
      challenge_ts: verification.challenge_ts,
      hostname: verification.hostname
    });
  } catch (error) {
    console.error('Turnstile endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Verification failed',
      'error-codes': ['internal-error']
    });
  }
});

// Signing key endpoint removed - signature validation simplified

// Endpoint to refresh an existing verified session. It deliberately does not
// mint sessions; Turnstile verification is the only session creation path.
app.get('/api/auth/session', authLimiter, async (req, res) => {
  try {
    const sessionId = req.cookies.bsod_session_id;
    const sessionHash = req.cookies.bsod_session_hash;
    const clientIp = getClientIp(req);

    if (!sessionId || !sessionHash) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Turnstile verification required', code: 'TURNSTILE_REQUIRED' });
    }

    const validation = await validateSession(sessionId, sessionHash);
    if (!validation.valid || !validation.sessionData?.turnstileVerified) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Turnstile verification required', code: 'TURNSTILE_REQUIRED' });
    }

    validation.sessionData.timestamp = Date.now();
    await storeSession(sessionId, validation.sessionData);
    const cookieOptions = setSessionCookies(res, sessionId, sessionHash);
    res.cookie('bsod_turnstile_verified', 'true', {
      ...cookieOptions,
      httpOnly: false,
      maxAge: 2 * 60 * 60 * 1000
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Session refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh session' });
  }
});


function getPromptText(contents) {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents) && contents.length > 0) {
    return contents
      .flatMap(content => Array.isArray(content?.parts) ? content.parts : [])
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('\n');
  }
  if (contents && typeof contents === 'object' && Array.isArray(contents.parts)) {
    return contents.parts
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('\n');
  }
  return '';
}

function validateAnalysisPrompt(contents) {
  const promptText = getPromptText(contents).trim();
  if (!promptText) {
    return { valid: false, reason: 'Invalid contents structure' };
  }
  if (promptText.length > AI_MAX_PROMPT_CHARS) {
    return { valid: false, reason: `Prompt exceeds ${AI_MAX_PROMPT_CHARS} characters` };
  }

  // Allow-list shapes come from shared/promptTemplates.js — the same constants
  // the client/server builders use, so they cannot drift out of sync.
  const match = PROMPT_SHAPES.find(shape =>
    promptText.startsWith(shape.startsWith) &&
    shape.required.every(marker => promptText.includes(marker))
  );
  if (!match) {
    return { valid: false, reason: 'Prompt does not match an allowed crash-analysis template' };
  }

  return { valid: true, promptText, promptType: match.type };
}

function extractJsonText(text) {
  let jsonText = String(text || '').trim();
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  jsonText = jsonText.trim();
  if (!jsonText.startsWith('{')) {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];
  }
  return jsonText;
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function sanitizeStringArray(value, maxItems = 12, maxLength = 600) {
  if (!Array.isArray(value)) return null;
  const sanitized = value
    .map(item => sanitizeString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
  return sanitized.length > 0 ? sanitized : null;
}

function normalizeAnalysisReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;

  const summary = sanitizeString(report.summary, 1000);
  const probableCause = sanitizeString(report.probableCause, 4000);
  const culprit = sanitizeString(report.culprit, 512);
  const recommendations = sanitizeStringArray(report.recommendations, 12, 800);

  if (!summary || !probableCause || !culprit || !recommendations) {
    return null;
  }

  const normalized = {
    ...report,
    summary,
    probableCause,
    culprit,
    recommendations
  };

  if (Array.isArray(normalized.driverWarnings)) {
    // Filter out malformed driver warnings (AI sometimes returns entries with empty fields)
    normalized.driverWarnings = normalized.driverWarnings
      .map(w => ({
        driverName: sanitizeString(w.driverName || w.name, 256),
        displayName: sanitizeString(w.displayName || w.name || w.driverName, 512),
        manufacturer: sanitizeString(w.manufacturer, 256) || 'Unknown',
        category: sanitizeString(w.category, 128) || 'other',
        issues: sanitizeStringArray(w.issues, 10, 500) ||
          (sanitizeString(w.description, 500) ? [sanitizeString(w.description, 500)] : []),
        recommendations: sanitizeStringArray(w.recommendations, 10, 500) || [],
        isAssociatedWithBugCheck: !!w.isAssociatedWithBugCheck
      }))
      .filter(w => w.driverName && w.displayName && w.manufacturer)
      .slice(0, 20);
  }
  if (Array.isArray(normalized.parameterAnalysis)) {
    // Filter out malformed parameter analysis entries
    normalized.parameterAnalysis = normalized.parameterAnalysis
      .filter(p => p && typeof p === 'object' &&
        p.rawValue && typeof p.rawValue === 'string' && p.rawValue.trim() &&
        p.decoded && typeof p.decoded === 'string' && p.decoded.trim()
      )
      .slice(0, 12);
  }
  // Ensure hardwareError has valid structure if present
  if (normalized.hardwareError && typeof normalized.hardwareError === 'object') {
    if (normalized.hardwareError.type && !normalized.hardwareError.errorType) {
      normalized.hardwareError.errorType = sanitizeString(normalized.hardwareError.type, 256) || 'Hardware error';
    }
    if (typeof normalized.hardwareError.details === 'string') {
      normalized.hardwareError.details = [normalized.hardwareError.details];
    }
    normalized.hardwareError.details = sanitizeStringArray(normalized.hardwareError.details, 12, 800) || [];
    normalized.hardwareError.recommendations = sanitizeStringArray(normalized.hardwareError.recommendations, 10, 800) || [];
    normalized.hardwareError.component = sanitizeString(normalized.hardwareError.component, 256) || 'Unknown';
    normalized.hardwareError.severity = sanitizeString(normalized.hardwareError.severity, 128) || 'fatal';
    normalized.hardwareError.isHardwareError = !!normalized.hardwareError.isHardwareError || !!normalized.hardwareError.errorType;
    if (!normalized.hardwareError.isHardwareError) {
      delete normalized.hardwareError; // Remove if not actually a hardware error
    }
  }

  return normalized;
}

function parseAndValidateAnalysisReport(text) {
  const jsonText = extractJsonText(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { valid: false, reason: 'AI response was not valid JSON' };
  }

  const report = normalizeAnalysisReport(parsed);
  if (!report) {
    return { valid: false, reason: 'AI response did not match the analysis report schema' };
  }

  return { valid: true, report, text: JSON.stringify(report) };
}

const SERVER_REPORT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    probableCause: { type: 'string' },
    culprit: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
    driverWarnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          driverName: { type: 'string' },
          displayName: { type: 'string' },
          manufacturer: { type: 'string' },
          category: { type: 'string' },
          issues: { type: 'array', items: { type: 'string' } },
          recommendations: { type: 'array', items: { type: 'string' } },
          isAssociatedWithBugCheck: { type: 'boolean' }
        }
      }
    },
    hardwareError: {
      type: 'object',
      properties: {
        isHardwareError: { type: 'boolean' },
        errorType: { type: 'string' },
        component: { type: 'string' },
        severity: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } }
      }
    },
    parameterAnalysis: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          parameter: { type: 'string' },
          rawValue: { type: 'string' },
          decoded: { type: 'string' },
          significance: { type: 'string' }
        }
      }
    }
  },
  required: ['summary', 'probableCause', 'culprit', 'recommendations']
});

// Proxy endpoint for Gemini API calls - now requires session
app.post('/api/gemini/generateContent', geminiLimiter, geminiConcurrency, requireSession, defaultJsonParser, async (req, res) => {
  try {
    // Check if Gemini AI is configured
    if (!genAI) {
      return res.status(503).json({ 
        error: 'AI service not configured. Please try again later.' 
      });
    }
    
    // Validate request size
    const requestSize = JSON.stringify(req.body).length;
    if (requestSize > SECURITY_CONFIG.api.maxRequestSize) {
      return res.status(413).json({ 
        error: `Request too large. Maximum size is ${SECURITY_CONFIG.api.maxRequestSize / 1024 / 1024}MB` 
      });
    }
    const { contents, generationConfig, config, fileHash } = req.body;
    const sessionId = req.cookies.bsod_session_id;

    // Security: Session validation is handled by requireSession middleware
    // Additional security layers: rate limiting, prompt validation, system instruction

    // SECURITY: Check per-session rate limiting (prevent abuse even with valid prompts)
    const now = Date.now();
    let sessionTracking = await loadSessionTracking(sessionId);

    if (!sessionTracking || now > sessionTracking.resetTime) {
      // Initialize or reset tracking
      sessionTracking = {
        count: 0,
        resetTime: now + (60 * 60 * 1000), // Reset after 1 hour
        totalTokens: 0
      };
    }

    // Check request limit
    if (sessionTracking.count >= REQUEST_LIMIT_PER_SESSION) {
      log.warn('session.rate_limit', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        requestCount: sessionTracking.count,
        resetTime: sessionTracking.resetTime
      });
      return res.status(429).json({
        error: `Rate limit exceeded. Maximum ${REQUEST_LIMIT_PER_SESSION} analysis requests per hour.`,
        code: 'SESSION_RATE_LIMIT',
        resetTime: sessionTracking.resetTime
      });
    }

    const validation = validateAnalysisPrompt(contents);
    if (!validation.valid) {
      log.warn('prompt.blocked', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        reason: validation.reason,
        promptPreview: getPromptText(contents).substring(0, 150)
      });
      return res.status(400).json({
        error: 'Invalid request. This endpoint only analyzes Windows crash dumps and BSOD errors.',
        code: 'INVALID_PROMPT'
      });
    }

    // Cache-stable prefix + dump evidence already arrives fully formed from the
    // client; the JSON contract lives inside the shared prefix. Forwarding it
    // verbatim keeps the implicit-cache prefix byte-stable.
    const serverPrompt = validation.promptText;

    // Estimate tokens in request (rough estimate: 1 token = 4 characters)
    const requestText = serverPrompt;
    const estimatedInputTokens = Math.ceil(requestText.length / 4);

    // Check token limit
    if (sessionTracking.totalTokens + estimatedInputTokens > TOKEN_LIMIT_PER_SESSION) {
      log.warn('session.token_limit', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        totalTokens: sessionTracking.totalTokens,
        estimatedRequest: estimatedInputTokens
      });
      return res.status(429).json({
        error: 'Token quota exceeded for this session. Please try again later.',
        code: 'SESSION_TOKEN_LIMIT',
        resetTime: sessionTracking.resetTime
      });
    }

    // Check cache using fileHash only after the session has proven ownership by
    // uploading that exact file. Otherwise fall back to the prompt hash.
    let ownedFileHash = false;
    if (typeof fileHash === 'string' && HASH_RE.test(fileHash)) {
      ownedFileHash = await sessionOwnsHash(req.sessionId, fileHash);
    }
    const cacheKey = ownedFileHash ? fileHash : hashContent(requestText);
    const cachedResponse = await getCachedAIReport(cacheKey);
    if (cachedResponse) {
      const cachedText = typeof cachedResponse.text === 'string'
        ? cachedResponse.text
        : JSON.stringify(cachedResponse);
      const cachedValidation = parseAndValidateAnalysisReport(cachedText);
      if (cachedValidation.valid) {
        log.info('gemini.cache.hit', { keyed: ownedFileHash ? 'fileHash' : 'prompt', fileHash: ownedFileHash ? fileHash : undefined });
        return res.json({
          ...cachedResponse,
          candidates: [{ content: { parts: [{ text: cachedValidation.text }] } }],
          text: cachedValidation.text,
          cached: true
        });
      }
      log.warn('gemini.cache.invalid', { keyed: ownedFileHash ? 'fileHash' : 'prompt', reason: cachedValidation.reason });
    }
    log.info('gemini.cache.miss', { keyed: ownedFileHash ? 'fileHash' : 'prompt', fileHash: ownedFileHash ? fileHash : undefined });

    // Increment request count and token usage
    sessionTracking.count++;
    sessionTracking.totalTokens += estimatedInputTokens;
    await storeSessionTracking(sessionId, sessionTracking);
    
    // Always use the model from config file (re-read with 30s TTL so model.cfg can be
    // swapped at runtime) — ignore any client-provided model for security.
    const modelName = getPrimaryModel();

    // Accept only narrow generation controls from the browser. Tool use, response
    // schemas, stop sequences, model overrides, and sampling breadth are server-owned.
    const frontendConfig = config || generationConfig || {};
    const sdkConfig = {
      responseMimeType: 'application/json',
      candidateCount: 1,
      temperature: 0.5,
      maxOutputTokens: 4096,
      responseSchema: SERVER_REPORT_RESPONSE_SCHEMA
    };
    if (Number.isFinite(frontendConfig.maxOutputTokens)) {
      sdkConfig.maxOutputTokens = Math.min(Math.max(Math.floor(frontendConfig.maxOutputTokens), 256), 4096);
    }
    if (Number.isFinite(frontendConfig.temperature)) {
      sdkConfig.temperature = Math.min(Math.max(frontendConfig.temperature, 0), 1);
    }

    // Constant across every analysis call (shared) — systemInstruction is part
    // of the cached context, so keeping it identical avoids fragmenting the
    // implicit-cache namespace.
    sdkConfig.systemInstruction = SYSTEM_INSTRUCTION_ANALYSIS;

    const response = await generateWithFallback({
      model: modelName,
      contents: serverPrompt,
      config: sdkConfig
    });

    // Track real input + output tokens using Gemini's usageMetadata when available;
    // fall back to char/4 only when the API didn't report counts. The new SDK exposes
    // response.text as a getter (not a method).
    const responseText = response.text ?? '';
    const actualInputTokens = response.usageMetadata?.promptTokenCount ?? estimatedInputTokens;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? Math.ceil(responseText.length / 4);
    sessionTracking.totalTokens += actualInputTokens + outputTokens - estimatedInputTokens;
    await storeSessionTracking(sessionId, sessionTracking);

    // Log finish reason to diagnose truncation issues
    const finishReason = response.candidates?.[0]?.finishReason || 'UNKNOWN';
    const reportValidation = parseAndValidateAnalysisReport(responseText);

    log.info('gemini.request', {
      sessionId: sessionId?.substring(0, 10) + '...',
      model: response.modelVersion || modelName,
      promptType: validation.promptType,
      inputTokens: actualInputTokens,
      inputEstimate: estimatedInputTokens,
      outputTokens,
      cachedContentTokens: response.usageMetadata?.cachedContentTokenCount || 0,
      // Implicit-cache effectiveness: share of input tokens served from cache.
      // Should rise above 0 once a stable prefix has been seen recently.
      cacheHitRatio: Number(
        ((response.usageMetadata?.cachedContentTokenCount || 0) /
          Math.max(1, actualInputTokens)).toFixed(3)
      ),
      finishReason,
      sessionTotal: sessionTracking.totalTokens,
      requestsRemaining: REQUEST_LIMIT_PER_SESSION - sessionTracking.count
    });

    if (!reportValidation.valid) {
      log.warn('gemini.response.invalid', {
        sessionId: sessionId?.substring(0, 10) + '...',
        reason: reportValidation.reason,
        finishReason,
        responsePreview: responseText.substring(0, 200)
      });
      return res.status(502).json({
        error: 'AI response failed validation',
        code: 'INVALID_AI_RESPONSE'
      });
    }

    const validatedText = reportValidation.text;
    const responseData = {
      candidates: [{ content: { parts: [{ text: validatedText }] }, finishReason }],
      usageMetadata: response.usageMetadata,
      modelVersion: response.modelVersion,
      text: validatedText
    };

    // Cache only a validated analysis response.
    await setCachedAIReport(cacheKey, responseData);

    res.json(responseData);
  } catch (error) {
    log.error('gemini.error', { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
    res.status(500).json({ error: 'AI analysis failed. Please try again later.' });
  }
});

// ============================================================
// WinDBG Server Proxy Endpoints
// ============================================================

const WINDBG_API_BASE_URL = normalizeWinDbgApiBaseUrl(
  process.env.WINDBG_API_BASE_URL || process.env.WINDBG_API_URL || DEFAULT_WINDBG_API_BASE_URL
);
const WINDBG_API_KEY = process.env.WINDBG_API_KEY;

if (!WINDBG_API_KEY) {
  console.warn('WARNING: WINDBG_API_KEY not configured - WinDBG analysis will fall back to local parsing');
}

// Map a WinDBG upstream error to an HTTP status: an invalid/garbled or failing
// upstream response is a bad-gateway (502), not an internal error (500), so the
// browser can retry the poll instead of treating it as a hard local failure.
function winDbgUpstreamHttpStatus(error) {
  const code = error?.code;
  if (code === 'WINDBG_UPSTREAM_INVALID_JSON' || code === 'WINDBG_UPSTREAM_ERROR') {
    return 502;
  }
  return 500;
}

// Get cached analysis by file hash (skip upload for known-cached files)
// Returns combined WinDBG analysis and AI report from single cache key
app.get('/api/cache/get', cacheLimiter, requireSession, async (req, res) => {
  try {
    const { hash } = req.query;

    if (!hash || typeof hash !== 'string' || !HASH_RE.test(hash)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing hash parameter'
      });
    }
    if (!(await sessionOwnsHash(req.sessionId, hash))) {
      return res.status(403).json({
        success: false,
        error: 'Cache entry is not available for this session',
        code: 'CACHE_FORBIDDEN'
      });
    }

    // Use new combined cache (with legacy fallback built-in)
    const cached = await getCachedAnalysis(hash);

    if (cached && (cached.windbgOutput || cached.aiReport)) {
      console.log(`[Cache] GET hit for hash ${hash.substring(0, 12)}...`);
      return res.json({
        success: true,
        cached: true,
        windbgAnalysis: cached.windbgOutput || null,
        aiReport: cached.aiReport || null,
        fileHash: hash
      });
    }

    console.log(`[Cache] GET miss for hash ${hash.substring(0, 12)}...`);
    return res.json({
      success: false,
      cached: false,
      error: 'Not found in cache'
    });
  } catch (error) {
    console.error('[Cache] Error getting cached analysis:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get cached analysis'
    });
  }
});

// Client-side cache writes are disabled to prevent cache poisoning. Cache writes
// happen server-side after validated WinDBG/Gemini work.
app.post('/api/cache/set', cacheLimiter, requireSession, defaultJsonParser, async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'Client cache writes are disabled',
    code: 'CACHE_WRITE_DISABLED'
  });
});

// Check cache for file hashes (pre-upload detection)
app.post('/api/cache/check', cacheLimiter, requireSession, defaultJsonParser, async (req, res) => {
  try {
    const { hashes } = req.body;

    if (!hashes || !Array.isArray(hashes)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: hashes (array of file hashes)'
      });
    }

    // Limit number of hashes to check at once
    const hashesToCheck = hashes.slice(0, 20);
    const results = {};

    // Check each hash against the combined cache (with legacy fallback). This is
    // only a UI hint; ownership is established when the server sees the file
    // during WinDBG upload.
    const checkPromises = hashesToCheck
      .filter(hash => typeof hash === 'string' && HASH_RE.test(hash))
      .map(async (hash) => {
        const cached = await isAnalysisCached(hash);
        results[hash] = cached;
      });

    await Promise.all(checkPromises);

    console.log(`[Cache] Checked ${hashesToCheck.length} hashes, ${Object.values(results).filter(Boolean).length} cached`);

    return res.json({
      success: true,
      cached: results
    });
  } catch (error) {
    console.error('[Cache] Error checking cache:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to check cache'
    });
  }
});

// Upload dump file to WinDBG server
// Uses largeJsonParser to handle base64-encoded files up to 100MB (becomes ~133MB encoded)
app.post('/api/windbg/upload', windbgUploadLimiter, rejectLargeBody(MAX_UPLOAD_REQUEST_SIZE), windbgUploadConcurrency, requireSession, upload.single('file'), async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Use multipart form with "file" field.'
      });
    }

    let { uid } = req.body;
    let fileName = sanitizeUploadFileName(req.file.originalname || 'upload.dmp');
    const fileBuffer = req.file.buffer;

    if (!uid || typeof uid !== 'string' || !HASH_RE.test(uid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing uid field'
      });
    }

    const validation = validateUploadedBuffer(fileBuffer, fileName, { allowArchives: false });
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    const serverHash = hashContent(fileBuffer);
    if (uid !== serverHash) {
      log.warn('windbg.uid_mismatch', {
        supplied: uid.substring(0, 12),
        computed: serverHash.substring(0, 12),
        sessionId: req.sessionId?.substring(0, 10) + '...'
      });
    }
    uid = serverHash;
    await markSessionHash(req.sessionId, uid);

    // UID is now the file hash (computed client-side), use it directly for caching
    console.log('[WinDBG] File hash UID:', uid, 'Size:', fileBuffer.length);

    // Check cache for existing WinDBG analysis
    const cachedAnalysis = await getCachedWinDBGAnalysis(uid);
    if (cachedAnalysis) {
      console.log('[WinDBG] Cache HIT - returning cached analysis for:', fileName);
      return res.json({
        success: true,
        cached: true,
        cachedAnalysis: cachedAnalysis.windbgOutput,
        cachedSignal: cachedAnalysis.windbgSignal || cachedAnalysis.analysisSignalText,
        cachedStructured: cachedAnalysis.structured,
        data: { uid, queue_position: 0 }
      });
    }

    console.log('[WinDBG] Cache MISS - uploading file:', fileName, 'UID:', uid);

    const submitResult = await submitWinDbgJob({
      baseUrl: WINDBG_API_BASE_URL,
      apiKey: WINDBG_API_KEY,
      fileBuffer,
      fileName,
      signal: timeoutSignal(WINDBG_UPLOAD_TIMEOUT_MS)
    });
    await markWinDbgJob(req.sessionId, uid, uid, submitResult.job_id);

    console.log('[WinDBG] Upload accepted. Upstream job:', submitResult.job_id);
    res.json({
      success: true,
      message: 'WinDBG analysis queued',
      data: {
        uid,
        filename: fileName,
        size: fileBuffer.length,
        status: 'pending',
        queue_position: submitResult.queue_position ?? 0,
        total_pending: undefined
      }
    });
  } catch (error) {
    log.error('windbg.upload.fail', { message: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to upload file to the debugging server. Please try again later.'
    });
  }
});

// Poll WinDBG status
app.get('/api/windbg/status', windbgPollLimiter, requireSession, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    const { uid } = req.query;

    if (!uid || typeof uid !== 'string' || !HASH_RE.test(uid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing parameter: uid'
      });
    }
    const ownership = await getOwnedWinDbgJob(req.sessionId, uid);
    if (!ownership) {
      return res.status(403).json({
        success: false,
        error: 'WinDBG job is not available for this session',
        code: 'WINDBG_FORBIDDEN'
      });
    }

    const upstreamJobId = ownership.upstreamJobId || uid;
    console.log('[WinDBG] Checking status for UID:', uid, 'Upstream job:', upstreamJobId);

    const job = await getWinDbgJob({
      baseUrl: WINDBG_API_BASE_URL,
      apiKey: WINDBG_API_KEY,
      jobId: upstreamJobId,
      signal: timeoutSignal(WINDBG_POLL_TIMEOUT_MS)
    });
    const result = toLegacyWinDbgStatusResponse(job, uid);
    console.log('[WinDBG] Status response:', result.data?.status, 'for UID:', uid);

    // CRITICAL: Set no-cache headers on response to prevent browser/CDN caching
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.json(result);
  } catch (error) {
    console.error('[WinDBG] Status error:', error);
    res.status(winDbgUpstreamHttpStatus(error)).json({
      success: false,
      error: error.message || 'Failed to check WinDBG status',
      code: error.code
    });
  }
});

// Download WinDBG analysis result
app.get('/api/windbg/download', windbgPollLimiter, requireSession, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    const { uid } = req.query;

    if (!uid || typeof uid !== 'string' || !HASH_RE.test(uid)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing parameter: uid'
      });
    }
    const ownership = await getOwnedWinDbgJob(req.sessionId, uid);
    if (!ownership) {
      return res.status(403).json({
        success: false,
        error: 'WinDBG job is not available for this session',
        code: 'WINDBG_FORBIDDEN'
      });
    }

    const upstreamJobId = ownership.upstreamJobId || uid;
    const job = await getWinDbgJob({
      baseUrl: WINDBG_API_BASE_URL,
      apiKey: WINDBG_API_KEY,
      jobId: upstreamJobId,
      signal: timeoutSignal(WINDBG_DOWNLOAD_TIMEOUT_MS)
    });
    const status = toLegacyWinDbgStatusResponse(job, uid).data.status;
    if (status !== 'completed') {
      return res.status(409).json({
        success: false,
        error: `WinDBG analysis is not complete (status: ${status})`
      });
    }

    const {
      analysisText,
      analysisSignalText,
      structured
    } = extractWinDbgAnalysisPackage(job);
    if (!analysisText) {
      throw new Error('Completed WinDBG job did not include analysis output');
    }
    console.log('[WinDBG] Downloaded analysis:', analysisText.length, 'bytes', 'AI signal:', analysisSignalText.length, 'bytes');

    // Cache the WinDBG output (UID is the file hash)
    await setCachedWinDBGAnalysis(uid, {
      windbgOutput: analysisText,
      windbgSignal: analysisSignalText,
      structured,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      analysisText,
      analysisSignalText,
      structured
    });
  } catch (error) {
    log.error('windbg.download.fail', { message: error.message });
    res.status(winDbgUpstreamHttpStatus(error)).json({
      success: false,
      error: error.message || 'Failed to download WinDBG analysis',
      code: error.code
    });
  }
});

// ============================================================
// Archive Extraction Endpoint (7z/RAR)
// ============================================================
app.post('/api/extract-archive', archiveLimiter, rejectLargeBody(MAX_RAW_FILE_SIZE + 1024 * 1024), archiveConcurrency, requireSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const buffer = req.file.buffer;
    const fileName = sanitizeUploadFileName(req.file.originalname || 'archive');
    const validation = validateUploadedBuffer(buffer, fileName, { allowArchives: true });
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }
    const archiveType = detectArchiveType(buffer);

    if (!archiveType || archiveType === 'zip') {
      return res.status(400).json({
        success: false,
        error: 'File is not a supported archive format (.7z or .rar)'
      });
    }

    console.log(`[Archive] Extracting ${archiveType} archive: ${fileName} (${buffer.length} bytes)`);

    const extractedDumps = await extractDumpsFromArchive(buffer, fileName, archiveType);
    const totalExtractedSize = extractedDumps.reduce((sum, dump) => sum + dump.buffer.length, 0);
    if (totalExtractedSize > MAX_EXTRACTED_ARCHIVE_SIZE) {
      return res.status(400).json({
        success: false,
        error: `Extracted files are too large (${(totalExtractedSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${(MAX_EXTRACTED_ARCHIVE_SIZE / 1024 / 1024).toFixed(0)}MB.`
      });
    }

    if (extractedDumps.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No dump files (.dmp, .mdmp, .hdmp, .kdmp) found in archive'
      });
    }

    console.log(`[Archive] Extracted ${extractedDumps.length} dump file(s) from ${fileName}`);

    const outputZip = new JSZip();
    for (const dump of extractedDumps) {
      outputZip.file(dump.sourcePath || dump.fileName, dump.buffer, { compression: 'STORE' });
    }
    const zipBuffer = await outputZip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE'
    });

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${sanitizeUploadFileName(fileName.replace(/\.[^.]+$/, ''))}-dumps.zip"`,
      'X-Archive-Type': archiveType,
      'X-Original-Archive': encodeURIComponent(fileName)
    });
    res.send(zipBuffer);
  } catch (error) {
    console.error('[Archive] Extraction error:', error);
    res.status(400).json({
      success: false,
      error: 'Failed to extract archive. Please ensure it is a valid format and is not password-protected.'
    });
  }
});

// ============================================================
// External API Endpoint for BSOD Analysis
// ============================================================
// This endpoint accepts dump files and returns structured analysis
// Authentication: X-API-Key header with BSOD_API_KEY
// Used by external services (e.g., XenForo integration)

// Constants for WinDBG analysis
const WINDBG_POLL_INTERVAL_MS = 10000; // 10 seconds between polls
const WINDBG_MAX_POLL_ATTEMPTS = 30; // 5 minutes max (30 * 10s)
const WINDBG_TOTAL_TIMEOUT_MS = 300000; // 5 minute hard timeout

/**
 * Generate a unique UID for WinDBG uploads
 */
function generateWinDBGUID() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  return `API-${timestamp}-${random}`;
}

/**
 * Upload file buffer to WinDBG server
 */
async function uploadBufferToWinDBG(fileBuffer, fileName) {
  const result = await submitWinDbgJob({
    baseUrl: WINDBG_API_BASE_URL,
    apiKey: WINDBG_API_KEY,
    fileBuffer,
    fileName,
    signal: timeoutSignal(WINDBG_UPLOAD_TIMEOUT_MS)
  });

  return {
    success: true,
    jobId: result.job_id,
    data: result
  };
}

/**
 * Poll WinDBG server for analysis completion
 */
async function pollWinDBGStatus(jobId) {
  let attempts = 0;

  while (attempts < WINDBG_MAX_POLL_ATTEMPTS) {
    attempts++;
    console.log(`[API/WinDBG] Polling status (attempt ${attempts}/${WINDBG_MAX_POLL_ATTEMPTS})...`);

    const result = await getWinDbgJob({
      baseUrl: WINDBG_API_BASE_URL,
      apiKey: WINDBG_API_KEY,
      jobId,
      signal: timeoutSignal(WINDBG_POLL_TIMEOUT_MS)
    });

    console.log(`[API/WinDBG] Status: ${result.status}`);

    if (result.status === 'complete' || result.status === 'completed') {
      return result;
    }

    if (result.status === 'failed' || result.status === 'timed_out' || result.status === 'cancelled') {
      throw new Error(result.error || 'WinDBG analysis failed');
    }

    await new Promise(resolve => setTimeout(resolve, WINDBG_POLL_INTERVAL_MS));
  }

  throw new Error('WinDBG analysis timed out');
}

/**
 * Download analysis result from WinDBG server
 */
async function downloadWinDBGAnalysis(jobId) {
  const result = await getWinDbgJob({
    baseUrl: WINDBG_API_BASE_URL,
    apiKey: WINDBG_API_KEY,
    jobId,
    signal: timeoutSignal(WINDBG_DOWNLOAD_TIMEOUT_MS)
  });

  const analysisPackage = extractWinDbgAnalysisPackage(result);
  const { analysisText } = analysisPackage;
  if (!analysisText) {
    throw new Error('Completed WinDBG job did not include analysis output');
  }
  return analysisPackage;
}

/**
 * Extract culprit module from WinDBG output
 */
function extractCulpritFromWinDBG(windbgOutput) {
  const moduleMatch = windbgOutput.match(/MODULE_NAME:\s*(\S+)/i);
  if (moduleMatch) return moduleMatch[1];

  const imageMatch = windbgOutput.match(/IMAGE_NAME:\s*(\S+)/i);
  if (imageMatch) return imageMatch[1];

  const faultingMatch = windbgOutput.match(/FAULTING_MODULE:\s*\S+\s+(\S+)/i);
  if (faultingMatch) return faultingMatch[1];

  return 'Unknown';
}

/**
 * Generate AI report from WinDBG analysis
 * Uses cache to avoid redundant Gemini API calls
 */
// Extract the signal-bearing slice of a WinDBG analysis. Raw outputs run 500-650KB but
// ~96% is init banners, Path validation, per-module symbol-load diagnostics, and NatVis
// teardown. The diagnostic content (bugcheck code/args, stack text, FAILURE_BUCKET_ID,
// MODULE_NAME) sits between the "Bugcheck Analysis" header and the terminating `quit:`.
function extractCrashSignal(raw, maxBytes = 16384) {
  if (!raw || typeof raw !== 'string') return raw;

  const startMarker = raw.indexOf('Bugcheck Analysis');
  const headerStart = startMarker > -1 ? raw.lastIndexOf('\n***', startMarker) : -1;
  const quitIdx = raw.lastIndexOf('\nquit:');

  let slice;
  if (headerStart > -1 && quitIdx > headerStart) slice = raw.slice(headerStart, quitIdx);
  else if (headerStart > -1) slice = raw.slice(headerStart);
  else slice = raw.slice(0, maxBytes);

  slice = slice
    .split('\n')
    .filter(line => !/^NatVis script (loaded|unloaded)/.test(line))
    .filter(line => !/^\s*Deferred\s+/.test(line))
    .filter(line => !/^\*{10,}\s*(Preparing|Waiting|Path validation|Symbol Loading Error Summary)/.test(line))
    .join('\n');

  if (slice.length > maxBytes) {
    const head = Math.floor(maxBytes * 0.75);
    const tail = maxBytes - head - 40;
    slice = `${slice.slice(0, head)}\n\n[... ${slice.length - head - tail} bytes elided ...]\n\n${slice.slice(-tail)}`;
  }
  return slice;
}

// Durable capture of each analysis into WindowsForum's wf_crash_signal table (the
// idea-engine "Patch Stability Index" moat). The analyzer's own cache is 7-day TTL,
// so without this the ~8k/month web analyses are lost. Fire-and-forget + fully
// guarded: a no-op unless WF_CRASH_SIGNAL_URL + WF_CRASH_SIGNAL_KEY are set, and it
// never throws into the analysis path (best-effort persistence only).
const WF_CRASH_SIGNAL_URL = process.env.WF_CRASH_SIGNAL_URL || '';
const WF_CRASH_SIGNAL_KEY = process.env.WF_CRASH_SIGNAL_KEY || '';
const WF_CRASH_SIGNAL_TIMEOUT_MS = readPositiveInt(process.env.WF_CRASH_SIGNAL_TIMEOUT_MS, 5_000);

function persistCrashSignal(report, fileHash) {
  if (!WF_CRASH_SIGNAL_URL || !WF_CRASH_SIGNAL_KEY || !fileHash || !report) return;
  try {
    const bc = report.bugCheck || {};
    const sys = report.systemInfo || {};
    const loc = report.crashLocation || {};
    const fields = ['summary', 'probableCause', 'culprit', 'bugCheck', 'bugCheckCode', 'systemInfo'];
    const parsed = fields.reduce((n, k) => n + (report[k] ? 1 : 0), 0);
    const payload = {
      file_hash: String(fileHash).slice(0, 64),
      bug_check_code: bc.code || report.bugCheckCode || null,
      bug_check_name: bc.name || null,
      faulty_driver: report.culprit || loc.module || null,
      windows_version: sys.windowsVersion || null,
      crash_time: null,
      parse_confidence: Math.round((parsed / fields.length) * 100),
      raw_excerpt: (report.summary || '').slice(0, 2000),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), WF_CRASH_SIGNAL_TIMEOUT_MS);
    fetch(`${WF_CRASH_SIGNAL_URL.replace(/\/$/, '')}/crash-signal`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': WF_CRASH_SIGNAL_KEY },
      body: JSON.stringify(payload),
    }).then(r => { if (!r.ok) console.warn('[crash-signal] ingest http', r.status); })
      .catch(e => console.warn('[crash-signal] ingest failed:', e?.message || e))
      .finally(() => clearTimeout(t));
  } catch (e) {
    console.warn('[crash-signal] persist skipped:', e?.message || e);
  }
}

async function generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis, fileHash, options = {}) {
  // Check cache first — prefer stable fileHash; fall back to hashing the analysis text
  const cacheKey = fileHash || windbgAnalysis;
  const cachedReport = await getCachedAIReport(cacheKey);
  if (cachedReport) {
    const normalizedCachedReport = normalizeAnalysisReport(cachedReport);
    if (normalizedCachedReport) {
      console.log('[API/AI] Using cached AI report');
      persistCrashSignal(normalizedCachedReport, fileHash);  // idempotent — captures pre-hook analyses
      return { ...normalizedCachedReport, cached: true };
    }
    const cachedText = typeof cachedReport.text === 'string'
      ? cachedReport.text
      : JSON.stringify(cachedReport);
    const cachedValidation = parseAndValidateAnalysisReport(cachedText);
    if (cachedValidation.valid) {
      console.log('[API/AI] Using cached AI report');
      persistCrashSignal(cachedValidation.report, fileHash);  // idempotent — captures pre-hook analyses
      return { ...cachedValidation.report, cached: true };
    }
    log.warn('api_ai.cache.invalid', { reason: cachedValidation.reason });
  }

  console.log('[API/AI] Generating AI report from WinDBG analysis...');

  const structuredSignal = typeof options.analysisSignalText === 'string'
    ? options.analysisSignalText.trim()
    : '';
  const analysisForPrompt = structuredSignal || extractCrashSignal(windbgAnalysis);
  const promptSource = structuredSignal ? 'structured JSON' : 'raw excerpt';
  console.log(`[API/AI] WinDBG AI evidence (${promptSource}): ${windbgAnalysis.length} -> ${analysisForPrompt.length} chars`);

  // Invariant WinDBG instructions + JSON schema live in WINDBG_PREFIX (shared,
  // cache-stable). Only per-dump file info + relevant WinDBG evidence goes in
  // the tail so Gemini implicit caching can reuse the prefix across analyses.
  const evidence = `**File Information:**
- Filename: ${fileName}
- Dump Type: ${dumpType}
- File Size: ${fileSize} bytes

${WINDBG_OUTPUT_MARKER}
${structuredSignal ? 'Relevant structured JSON extracted from the WinDBG API result. Full stdout is intentionally omitted.' : 'Relevant WinDBG crash excerpt from the legacy raw output.'}
\`\`\`${structuredSignal ? 'json' : ''}
${analysisForPrompt}
\`\`\``;
  const prompt = wrapWithEvidence(WINDBG_PREFIX, evidence);

  try {
    const response = await generateWithFallback({
      model: getPrimaryModel(),
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: 4096,
        systemInstruction: SYSTEM_INSTRUCTION_ANALYSIS
      }
    });
    const responseText = response.text ?? '';

    const reportValidation = parseAndValidateAnalysisReport(responseText);
    if (!reportValidation.valid) {
      throw new Error(reportValidation.reason);
    }
    const report = reportValidation.report;

    // Cache the successful AI report under the stable file hash (or analysis text as fallback)
    await setCachedAIReport(cacheKey, report);
    persistCrashSignal(report, fileHash);   // durable WF capture (best-effort, env-gated)
    return report;
  } catch (error) {
    console.error('[API/AI] AI analysis error:', error);
    // Return basic report if AI fails (don't cache failures)
    return {
      summary: `Windows crash in ${fileName} analyzed by WinDBG`,
      probableCause: 'WinDBG analysis completed but AI interpretation failed.',
      culprit: extractCulpritFromWinDBG(windbgAnalysis),
      recommendations: [
        'Review the raw WinDBG output manually',
        'Update drivers mentioned in the analysis',
        'Check Windows Event Viewer for related errors'
      ]
    };
  }
}

/**
 * Determine dump type from file content
 */
function detectDumpType(fileBuffer) {
  // Check magic bytes
  const header = fileBuffer.slice(0, 8).toString('ascii');

  // MDMP = Minidump
  if (header.startsWith('MDMP')) {
    return 'minidump';
  }

  // PAGEDU64 = Full/Kernel dump
  if (header.startsWith('PAGEDU64') || header.startsWith('PAGEDUMP')) {
    return 'kernel';
  }

  // Default to kernel for large files
  if (fileBuffer.length >= 5 * 1024 * 1024) {
    return 'kernel';
  }

  return 'minidump';
}

// Extract dump files from ZIP archive
async function extractDumpsFromZip(zipBuffer, originalName) {
  const results = [];

  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    let fileCount = 0;
    let totalExtractedSize = 0;

    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      fileCount++;
      if (fileCount > MAX_ARCHIVE_FILE_COUNT) {
        throw new Error(`ZIP contains too many files. Maximum is ${MAX_ARCHIVE_FILE_COUNT}.`);
      }
      if (!validatePathEntry(path)) {
        throw new Error('ZIP contains an unsafe path');
      }

      const lowerPath = path.toLowerCase();
      const isDump = DUMP_EXTENSIONS.some(ext => lowerPath.endsWith(ext));

      if (isDump) {
        const listedSize = file._data?.uncompressedSize;
        if (Number.isFinite(listedSize)) {
          totalExtractedSize += listedSize;
          if (totalExtractedSize > MAX_EXTRACTED_ARCHIVE_SIZE) {
            throw new Error(`ZIP extraction size exceeds ${(MAX_EXTRACTED_ARCHIVE_SIZE / 1024 / 1024).toFixed(0)}MB.`);
          }
        }
        const content = await file.async('nodebuffer');
        if (!Number.isFinite(listedSize)) {
          totalExtractedSize += content.length;
        }
        if (totalExtractedSize > MAX_EXTRACTED_ARCHIVE_SIZE) {
          throw new Error(`ZIP extraction size exceeds ${(MAX_EXTRACTED_ARCHIVE_SIZE / 1024 / 1024).toFixed(0)}MB.`);
        }
        const fileName = sanitizeUploadFileName(path.split('/').pop());
        const validation = validateUploadedBuffer(content, fileName, { allowArchives: false });
        if (!validation.valid) {
          throw new Error(`Invalid dump inside ZIP: ${validation.error}`);
        }
        results.push({
          fileName,
          sourcePath: path,
          buffer: content,
          originalZip: originalName
        });
      }
    }
    if (zipBuffer.length > 0 && totalExtractedSize / zipBuffer.length > MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw new Error('ZIP compression ratio too high — possible archive bomb');
    }
  } catch (error) {
    console.error(`[ZIP] Failed to extract from ${originalName}:`, error.message);
    throw new Error(`Failed to extract ZIP: ${error.message}`);
  }

  return results;
}

/**
 * Extract .dmp files from a 7z/RAR archive.
 * Uses 7z for .7z files and bsdtar for .rar files (Alpine's 7zip lacks RAR codec).
 * Security: archive bomb detection, path traversal prevention, timeout
 */
async function extractDumpsFromArchive(buffer, originalName, archiveType) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsod-extract-'));
  const archivePath = path.join(tmpDir, `archive.${archiveType}`);
  const extractDir = path.join(tmpDir, 'out');

  try {
    fs.writeFileSync(archivePath, buffer);
    fs.mkdirSync(extractDir);

    // Archive bomb checks
    const MAX_EXTRACTED_SIZE = MAX_EXTRACTED_ARCHIVE_SIZE;
    const MAX_FILE_COUNT = MAX_ARCHIVE_FILE_COUNT;
    const MAX_COMPRESSION_RATIO = MAX_ARCHIVE_COMPRESSION_RATIO;

    if (archiveType === 'rar') {
      // Use bsdtar for RAR files (Alpine's 7zip lacks the RAR codec)
      // Step 1: List verbose contents for pre-extraction bomb detection.
      // bsdtar's long listing exposes each entry's uncompressed size, allowing
      // us to reject archive bombs before writing expanded data to disk.
      let listOutput;
      try {
        listOutput = await execFileAsync('bsdtar', ['tvf', archivePath], { timeout: 15000 });
      } catch (err) {
        if (err.stderr && (err.stderr.includes('password') || err.stderr.includes('encrypted'))) {
          throw new Error('Password-protected archives are not supported');
        }
        throw new Error(`Failed to read RAR archive: ${err.stderr || err.message}`);
      }

      let pathOutput;
      try {
        pathOutput = await execFileAsync('bsdtar', ['tf', archivePath], { timeout: 15000 });
      } catch (err) {
        throw new Error(`Failed to read RAR archive paths: ${err.stderr || err.message}`);
      }
      const listedPaths = pathOutput.stdout.trim().split('\n').filter(Boolean);
      for (const entryPath of listedPaths) {
        if (!validatePathEntry(entryPath)) {
          throw new Error('Archive contains an unsafe path');
        }
      }

      const fileList = listOutput.stdout.trim().split('\n').filter(f => f.length > 0);
      let totalListedSize = 0;
      for (const line of fileList) {
        if (/^\s*l/.test(line)) {
          throw new Error('Archive contains symbolic links, which are not supported');
        }
        const columns = line.trim().split(/\s+/);
        // Expected bsdtar -tvf shape: mode links owner group size date... name
        const size = Number.parseInt(columns[4], 10);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error('Failed to read RAR archive: unable to determine uncompressed size');
        }
        totalListedSize += size;
      }

      if (totalListedSize > MAX_EXTRACTED_SIZE) {
        throw new Error(`Archive too large when extracted (${(totalListedSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${(MAX_EXTRACTED_SIZE / 1024 / 1024).toFixed(0)}MB.`);
      }
      if (fileList.length > MAX_FILE_COUNT) {
        throw new Error(`Archive contains too many files (${fileList.length}). Maximum is ${MAX_FILE_COUNT}.`);
      }
      if (buffer.length > 0 && totalListedSize / buffer.length > MAX_COMPRESSION_RATIO) {
        throw new Error('Archive compression ratio too high — possible archive bomb');
      }

      // Step 2: Extract
      try {
        await execFileAsync('bsdtar', ['xf', archivePath, '-C', extractDir], { timeout: 30000 });
      } catch (err) {
        if (err.stderr && (err.stderr.includes('password') || err.stderr.includes('encrypted'))) {
          throw new Error('Password-protected archives are not supported');
        }
        throw new Error(`Failed to extract RAR archive: ${err.stderr || err.message}`);
      }

      // Post-extraction size check
      let totalSize = 0;
      function checkSize(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkSize(fullPath);
          } else {
            totalSize += fs.statSync(fullPath).size;
          }
        }
      }
      checkSize(extractDir);

      if (totalSize > MAX_EXTRACTED_SIZE) {
        throw new Error(`Archive too large when extracted (${(totalSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${(MAX_EXTRACTED_SIZE / 1024 / 1024).toFixed(0)}MB.`);
      }
      if (buffer.length > 0 && totalSize / buffer.length > MAX_COMPRESSION_RATIO) {
        throw new Error('Archive compression ratio too high — possible archive bomb');
      }
    } else {
      // Use 7z for .7z files
      // Step 1: List archive contents for bomb detection
      let listOutput;
      try {
        listOutput = await execFileAsync('7z', ['l', '-slt', archivePath], { timeout: 15000 });
      } catch (err) {
        if (err.stderr && err.stderr.includes('Wrong password')) {
          throw new Error('Password-protected archives are not supported');
        }
        throw new Error(`Failed to read archive: ${err.message}`);
      }

      const sizeMatches = listOutput.stdout.matchAll(/^Size = (\d+)$/gm);
      const pathMatches = listOutput.stdout.matchAll(/^Path = (.+)$/gm);
      let totalExtractedSize = 0;
      let fileCount = 0;

      for (const match of pathMatches) {
        const entryPath = match[1];
        if (entryPath === archivePath || entryPath === path.basename(archivePath)) continue;
        if (!validatePathEntry(entryPath)) {
          throw new Error('Archive contains an unsafe path');
        }
      }

      for (const match of sizeMatches) {
        totalExtractedSize += parseInt(match[1], 10);
        fileCount++;
      }

      if (totalExtractedSize > MAX_EXTRACTED_SIZE) {
        throw new Error(`Archive too large when extracted (${(totalExtractedSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${(MAX_EXTRACTED_SIZE / 1024 / 1024).toFixed(0)}MB.`);
      }
      if (fileCount > MAX_FILE_COUNT) {
        throw new Error(`Archive contains too many files (${fileCount}). Maximum is ${MAX_FILE_COUNT}.`);
      }
      if (buffer.length > 0 && totalExtractedSize / buffer.length > MAX_COMPRESSION_RATIO) {
        throw new Error('Archive compression ratio too high — possible archive bomb');
      }

      // Step 2: Extract
      try {
        await execFileAsync('7z', ['x', `-o${extractDir}`, '-y', archivePath], { timeout: 30000 });
      } catch (err) {
        if (err.stderr && err.stderr.includes('Wrong password')) {
          throw new Error('Password-protected archives are not supported');
        }
        throw new Error(`Failed to extract archive: ${err.message}`);
      }
    }

    // Step 3: Find .dmp files recursively, with path traversal protection
    const results = [];
    const realExtractDir = fs.realpathSync(extractDir);
    let dumpCount = 0;
    let dumpBytes = 0;

    function findDmpFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Reject any symlink outright — lstat avoids the realpath TOCTOU window and
        // guarantees we never follow a link out of the extract dir.
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isSymbolicLink()) {
          console.warn('[Archive] Symlink entry rejected:', fullPath);
          continue;
        }

        // Defense in depth: still verify the resolved path stays within realExtractDir.
        const realPath = fs.realpathSync(fullPath);
        if (realPath !== realExtractDir && !realPath.startsWith(realExtractDir + path.sep)) {
          console.warn('[Archive] Path traversal detected, skipping:', fullPath);
          continue;
        }
        if (entry.isDirectory()) {
          findDmpFiles(fullPath);
        } else if (DUMP_EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext))) {
          if (dumpCount >= MAX_FILE_COUNT) {
            throw new Error(`Archive contains too many dump files. Maximum is ${MAX_FILE_COUNT}.`);
          }
          if (lstat.size > MAX_RAW_FILE_SIZE) {
            throw new Error(`Extracted dump is too large (${(lstat.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${(MAX_RAW_FILE_SIZE / 1024 / 1024).toFixed(0)}MB.`);
          }
          if (dumpBytes + lstat.size > MAX_EXTRACTED_SIZE) {
            throw new Error(`Extracted dumps exceed ${(MAX_EXTRACTED_SIZE / 1024 / 1024).toFixed(0)}MB.`);
          }
          const content = fs.readFileSync(fullPath);
          dumpCount++;
          dumpBytes += content.length;
          const sourcePath = path.relative(extractDir, fullPath).replace(/\\/g, '/');
          const fileName = sanitizeUploadFileName(entry.name);
          const validation = validateUploadedBuffer(content, fileName, { allowArchives: false });
          if (!validation.valid) {
            console.warn('[Archive] Invalid dump skipped:', validation.error);
            continue;
          }
          results.push({
            fileName,
            sourcePath,
            buffer: content,
            originalArchive: originalName
          });
        }
      }
    }

    findDmpFiles(extractDir);
    return results;
  } finally {
    // Always clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error('[Archive] Cleanup error:', cleanupErr.message);
    }
  }
}

// Main external API endpoint
// Main external API endpoint
app.post('/api/analyze', externalAnalyzeLimiter, requireApiKey, rejectLargeBody(MAX_RAW_FILE_SIZE + 1024 * 1024), externalAnalyzeConcurrency, upload.single('file'), async (req, res) => {
  const startTime = Date.now();

  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Use multipart form with "file" field.',
        code: 'NO_FILE'
      });
    }

    let fileBuffer = req.file.buffer;
    let fileName = sanitizeUploadFileName(req.file.originalname || 'upload.dmp');
    const originalFileSize = fileBuffer.length;
    let originalZip = null;

    const initialValidation = validateUploadedBuffer(fileBuffer, fileName, { allowArchives: true });
    if (!initialValidation.valid) {
      return res.status(400).json({
        success: false,
        error: initialValidation.error,
        code: 'INVALID_FILE'
      });
    }

    console.log(`[API/Analyze] Received file: ${fileName} (${originalFileSize} bytes)`);

    // Check if file is an archive and extract dumps
    const archiveType = detectArchiveType(fileBuffer);
    if (archiveType) {
      console.log(`[API/Analyze] Detected ${archiveType} archive, extracting dumps...`);

      let extractedDumps;
      if (archiveType === 'zip') {
        extractedDumps = await extractDumpsFromZip(fileBuffer, fileName);
      } else {
        extractedDumps = await extractDumpsFromArchive(fileBuffer, fileName, archiveType);
      }

      if (extractedDumps.length === 0) {
        return res.status(400).json({
          success: false,
          error: `No dump files (.dmp, .mdmp, .hdmp, .kdmp) found in ${archiveType.toUpperCase()} archive`,
          code: 'NO_DUMPS_IN_ARCHIVE'
        });
      }

      // Use the first dump found (could enhance to analyze all)
      const firstDump = extractedDumps[0];
      console.log(`[API/Analyze] Found ${extractedDumps.length} dump(s), analyzing: ${firstDump.fileName}`);
      originalZip = fileName;
      fileName = sanitizeUploadFileName(firstDump.fileName);
      fileBuffer = firstDump.buffer;
    }

    const dumpValidation = validateUploadedBuffer(fileBuffer, fileName, { allowArchives: false });
    if (!dumpValidation.valid) {
      return res.status(400).json({
        success: false,
        error: dumpValidation.error,
        code: 'INVALID_DUMP'
      });
    }

    const fileSize = fileBuffer.length;

    // Detect dump type
    const dumpType = detectDumpType(fileBuffer);
    console.log(`[API/Analyze] Detected dump type: ${dumpType}`);

    // Compute file hash for caching
    const fileHash = hashContent(fileBuffer);
    console.log(`[API/Analyze] File hash: ${fileHash.substring(0, 12)}...`);

    // Generate UID for this job
    const uid = generateWinDBGUID();

    // Check cache for previous WinDBG analysis of this exact file
    const cachedAnalysis = await getCachedWinDBGAnalysis(fileHash);
    if (cachedAnalysis) {
      log.info('analyze.windbg_cache.hit', { fileHash: fileHash.substring(0, 12) });

      // Generate AI report from cached WinDBG output
      const report = await generateAIReportFromWinDBG(
        fileName,
        dumpType,
        fileSize,
        cachedAnalysis.windbgOutput,
        fileHash,
        {
          analysisSignalText: cachedAnalysis.windbgSignal || cachedAnalysis.analysisSignalText,
          structured: cachedAnalysis.structured
        }
      );

      const processingTime = (Date.now() - startTime) / 1000;
      log.info('analyze.complete', { processingTime, analysisMethod: 'windbg', cached: true, dumpType, fileSize });

      const jobData = {
        status: 'completed',
        fileName,
        dumpType,
        fileSize,
        uid,
        originalZip: originalZip || undefined,
        error: null,
        data: report,
        analysisMethod: 'windbg',
        processingTime,
        timestamp: Date.now()
      };
      await storeJob(uid, jobData);

      return res.status(202).json({
        success: true,
        status: 'completed',
        uid,
        checkStatusUrl: `/api/analyze/status/${uid}`
      });
    }

    console.log('[API/Analyze] Cache MISS - setting up background WinDBG analysis');

    // Check if WinDBG is configured
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG analysis service not configured',
        code: 'WINDBG_NOT_CONFIGURED'
      });
    }

    // Check if Gemini AI is configured
    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: 'AI service not configured',
        code: 'AI_NOT_CONFIGURED'
      });
    }

    // Create job state
    const jobData = {
      status: 'processing',
      fileName,
      dumpType,
      fileSize,
      uid,
      originalZip: originalZip || undefined,
      error: null,
      data: null,
      analysisMethod: 'windbg',
      processingTime: null,
      timestamp: Date.now()
    };
    await storeJob(uid, jobData);

    // Run the analysis pipeline asynchronously in the background
    (async () => {
      try {
        const runStartTime = Date.now();
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error('Analysis timed out after 5 minutes'));
          }, WINDBG_TOTAL_TIMEOUT_MS);
        });

        const analysisPromise = (async () => {
          // Step 1: Upload to WinDBG
          console.log(`[API/Analyze] Job ${uid} Step 1: Uploading to WinDBG server...`);
          const uploadResult = await uploadBufferToWinDBG(fileBuffer, fileName);
          if (!uploadResult.success) {
            throw new Error(uploadResult.error || 'WinDBG upload failed');
          }
          const upstreamJobId = uploadResult.jobId;

          // Step 2: Poll for completion
          console.log(`[API/Analyze] Job ${uid} Step 2: Polling for completion...`);
          await pollWinDBGStatus(upstreamJobId);

          // Step 3: Download results
          console.log(`[API/Analyze] Job ${uid} Step 3: Downloading analysis...`);
          const windbgPackage = await downloadWinDBGAnalysis(upstreamJobId);
          const windbgAnalysis = windbgPackage.analysisText;

          // Cache the WinDBG analysis for future requests with same file
          await setCachedWinDBGAnalysis(fileHash, {
            windbgOutput: windbgAnalysis,
            windbgSignal: windbgPackage.analysisSignalText,
            structured: windbgPackage.structured,
            uid,
            fileName,
            dumpType,
            timestamp: Date.now()
          });

          // Step 4: Generate AI report
          console.log(`[API/Analyze] Job ${uid} Step 4: Generating AI report...`);
          const report = await generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis, fileHash, {
            analysisSignalText: windbgPackage.analysisSignalText,
            structured: windbgPackage.structured
          });

          return {
            report,
            windbgAnalysis,
            analysisMethod: 'windbg'
          };
        })();

        analysisPromise.catch(() => {});
        let result;
        try {
          result = await Promise.race([analysisPromise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutHandle);
        }

        const processingTime = (Date.now() - runStartTime) / 1000;
        log.info('analyze.complete', {
          processingTime,
          analysisMethod: result.analysisMethod,
          dumpType,
          fileSize
        });

        // Save complete status
        jobData.status = 'completed';
        jobData.data = result.report;
        jobData.processingTime = processingTime;
        jobData.timestamp = Date.now();
        await storeJob(uid, jobData);

      } catch (err) {
        console.error(`[API/Analyze] Job ${uid} failed:`, err);
        log.error('analyze.fail', {
          message: err.message,
          uid
        });

        jobData.status = 'failed';
        jobData.error = 'Analysis failed. Please ensure the uploaded file is a valid Windows crash dump.';
        jobData.timestamp = Date.now();
        await storeJob(uid, jobData);
      }
    })();

    // Respond immediately with 202 Accepted
    return res.status(202).json({
      success: true,
      status: 'processing',
      uid,
      checkStatusUrl: `/api/analyze/status/${uid}`
    });

  } catch (error) {
    const processingTime = (Date.now() - startTime) / 1000;
    log.error('analyze.fail', {
      message: error.message,
      processingTime
    });

    res.status(500).json({
      success: false,
      error: 'An internal error occurred while initiating the analysis. Please try again later.',
      code: 'ANALYSIS_INIT_FAILED',
      processingTime
    });
  }
});

// Poll status of external API analyze jobs
app.get('/api/analyze/status/:uid', externalAnalyzeLimiter, requireApiKey, async (req, res) => {
  const { uid } = req.params;
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid UID parameter' });
  }

  try {
    const job = await loadJob(uid);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    if (job.status === 'processing') {
      return res.json({
        success: true,
        status: 'processing'
      });
    }

    if (job.status === 'failed') {
      return res.status(500).json({
        success: false,
        status: 'failed',
        error: job.error || 'Analysis failed',
        code: 'ANALYSIS_FAILED'
      });
    }

    // Completed
    return res.json({
      success: true,
      status: 'completed',
      data: job.data,
      analysisMethod: job.analysisMethod,
      processingTime: job.processingTime,
      metadata: {
        fileName: job.fileName,
        fileSize: job.fileSize,
        dumpType: job.dumpType,
        uid: job.uid,
        originalZip: job.originalZip
      }
    });

  } catch (error) {
    console.error('[API/Analyze/Status] Error loading job:', error);
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while retrieving job status. Please try again later.'
    });
  }
});

// Normalize parser/upload/rate-limit store failures before the SPA catch-all.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  let status = error.status || error.statusCode || 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An internal server error occurred';

  if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    code = error.code;
    message = error.code === 'LIMIT_FILE_SIZE'
      ? `File is too large. Maximum size is ${(MAX_RAW_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`
      : `File is too large. Maximum size is ${(MAX_RAW_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`;
  } else if (['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes(error.code)) {
    status = 413;
    code = error.code;
    message = 'Multipart upload contains too many parts';
  } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    status = 400;
    code = error.code;
    message = error.message;
  } else if (error.type === 'entity.too.large') {
    status = 413;
    code = 'REQUEST_TOO_LARGE';
    message = 'Request body is too large';
  } else if (error.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON';
  } else if (/Invalid file type/i.test(error.message || '')) {
    status = 400;
    code = 'INVALID_FILE_TYPE';
    message = error.message;
  } else if (/Runtime store unavailable|Runtime store required/i.test(error.message || '')) {
    status = 503;
    code = 'RUNTIME_STORE_UNAVAILABLE';
    message = 'Service state store is temporarily unavailable';
  } else if (status < 500) {
    message = error.message || message;
  }

  log.error('request.error', {
    path: req.path,
    status,
    code,
    message: error.message
  });

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      success: false,
      error: message,
      code
    });
  }

  return res.status(status).send(process.env.NODE_ENV === 'production' ? message : error.stack || message);
});

const KNOWN_SPA_ROUTES = new Set([
  '/',
  '/analyzer',
  '/about',
  '/documentation',
  '/donate'
]);

function getSpaStatus(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return KNOWN_SPA_ROUTES.has(normalized) ? 200 : 404;
}

// Catch-all: serve React app for client-side routing
app.use((req, res) => {
  const pathname = req.path;

  // CRITICAL: Don't handle asset files with the catch-all route
  // Static files should be served by the static middleware
  if (pathname.startsWith('/assets/') ||
      pathname.match(/\.(js|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico|json|xml|txt|webmanifest)$/)) {
    // Return 404 for asset files that weren't found by static middleware
    return res.status(404).send('File not found');
  }

  // Serve React app for all other routes (non-asset routes only)
  // CDN caches 24h (purged on deploy), browser always revalidates
  res.status(getSpaStatus(pathname));
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Link header enables Cloudflare Early Hints (103) for critical assets
  if (earlyHintsLinkHeader) res.setHeader('Link', earlyHintsLinkHeader);

  // In development/local testing, read from disk to avoid stale memory caching
  if (process.env.NODE_ENV !== 'production') {
    try {
      const indexPath = path.join(__dirname, 'dist', 'index.html');
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8');
        res.send(html);
        return;
      }
    } catch (e) {
      console.error('Failed to read index.html dynamically in development:', e);
    }
  }

  res.send(cachedIndexHtml);
});

// Cache index.html in memory and ensure xxhash is ready before accepting requests
let cachedIndexHtml;
// Precomputed Link header for Early Hints / Cloudflare preloading
let earlyHintsLinkHeader = '';

async function startServer() {
  // Initialize xxhash before accepting requests
  [hasher] = await Promise.all([
    xxhash(),
    initHashing()
  ]);
  console.log('XXHash initialized for session management');

  if (REQUIRE_REDIS_RUNTIME && !isCacheEnabled()) {
    throw new Error('REQUIRE_REDIS_RUNTIME is enabled but Upstash Redis is not configured');
  }
  if (isCacheEnabled() && !(await checkCacheConnection())) {
    if (REQUIRE_REDIS_RUNTIME) {
      throw new Error('REQUIRE_REDIS_RUNTIME is enabled but Redis health check failed');
    }
    log.warn('redis.health.failed', { runtimeRequired: false });
  }

  // Cache index.html in memory (~9KB, avoids disk read on every request)
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
    console.log(`Cached index.html in memory (${Buffer.byteLength(cachedIndexHtml)} bytes)`);

    // Build Link header from built assets for Early Hints (Cloudflare)
    const distAssets = path.join(__dirname, 'dist', 'assets');
    if (fs.existsSync(distAssets)) {
      const files = fs.readdirSync(distAssets);
      const links = [];
      // Preload the main JS entry and CSS — these are render-critical
      const mainJs = files.find(f => f.match(/^index-.*\.js$/));
      const mainCss = files.find(f => f.match(/^index-.*\.css$/));
      if (mainCss) links.push(`</assets/${mainCss}>; rel=preload; as=style; crossorigin`);
      if (mainJs) links.push(`</assets/${mainJs}>; rel=modulepreload; crossorigin`);
      if (links.length) {
        earlyHintsLinkHeader = links.join(', ');
        console.log(`Early Hints Link header: ${earlyHintsLinkHeader}`);
      }
    }
  } else {
    console.warn('dist/index.html not found - run npm run build first');
    cachedIndexHtml = '<html><body>Build not found. Run npm run build.</body></html>';
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Gemini API Key configured: ${process.env.GEMINI_API_KEY ? 'Yes' : 'No'}`);
    console.log(`Turnstile Secret Key configured: ${TURNSTILE_SECRET_KEY ? 'Yes' : 'No'}`);
    console.log(`WinDBG API Key configured: ${WINDBG_API_KEY ? 'Yes' : 'No'}`);
    console.log(`WinDBG API Base URL: ${WINDBG_API_BASE_URL}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
