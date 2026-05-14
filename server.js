import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GoogleGenAI } from '@google/genai';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import xxhash from 'xxhash-wasm';
import { SECURITY_CONFIG } from './serverConfig.js';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import multer from 'multer';
import JSZip from 'jszip';
import net from 'net';

const execFileAsync = promisify(execFile);
import {
  initCache,
  hashContent,
  getCachedAIReport,
  setCachedAIReport,
  getCachedWinDBGAnalysis,
  setCachedWinDBGAnalysis,
  getCachedAnalysis,
  isAnalysisCached,
  getRuntimeValue,
  setRuntimeValue,
  deleteRuntimeValue
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

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers (required for Cloud Run). With Cloudflare in front of
// Cloud Run, the X-Forwarded-For chain is [user-ip, cloudflare-edge-ip] as the
// platform appends its view of the connecting peer. TRUST_PROXY_HOPS defaults
// to 2 to walk past both hops; CF-Connecting-IP (set by Cloudflare) is treated
// as authoritative in getClientIp regardless.
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS || '2', 10);
app.set('trust proxy', Number.isFinite(TRUST_PROXY_HOPS) ? TRUST_PROXY_HOPS : 2);

const MAX_RAW_FILE_SIZE = SECURITY_CONFIG.api.maxRawFileSize;
const MAX_UPLOAD_REQUEST_SIZE = SECURITY_CONFIG.api.maxUploadRequestSize;
const MAX_EXTRACTED_ARCHIVE_SIZE = SECURITY_CONFIG.api.maxExtractedArchiveSize;
const DUMP_EXTENSIONS = ['.dmp', '.mdmp', '.hdmp', '.kdmp'];
const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar'];
const HASH_RE = /^[a-f0-9]{8,16}$/i;
const TURNSTILE_ACTION = process.env.TURNSTILE_ACTION || 'file-upload';

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
// With Cloudflare-only ingress enforced below, this header is authoritative in
// production. In dev (or with the gate disabled), fall back to req.ip.
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) return cfIp;
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
  return ipKeyGenerator(getClientIp(req));
}

function jsonRateLimitHandler(req, res) {
  res.status(429).json({
    success: false,
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMITED'
  });
}

function makeLimiter({ windowMs, max, keyGenerator = rateLimitKey }) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    handler: jsonRateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false
  });
}

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

function sanitizeUploadFileName(fileName) {
  const base = path.basename(String(fileName || 'upload.dmp'));
  const cleaned = base.replace(/[\r\n"]/g, '_').replace(/[^\w.\-() ]+/g, '_').trim();
  return cleaned || 'upload.dmp';
}

function getFileExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return ext;
}

function detectDumpMagic(buffer) {
  const header = buffer.slice(0, 8).toString('ascii');
  return header.startsWith('MDMP') || header.startsWith('PAGEDU64') || header.startsWith('PAGEDUMP') || header.startsWith('PAGE');
}

function validatePathEntry(entryPath, maxDepth = 4) {
  const normalized = String(entryPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) return false;
  return parts.length <= maxDepth;
}

function validateUploadedBuffer(fileBuffer, fileName, { allowArchives = true } = {}) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    return { valid: false, error: 'File is empty or invalid' };
  }
  if (fileBuffer.length > MAX_RAW_FILE_SIZE) {
    return { valid: false, error: `File is too large. Maximum size is ${(MAX_RAW_FILE_SIZE / 1024 / 1024).toFixed(0)}MB` };
  }

  const ext = getFileExtension(fileName);
  if (DUMP_EXTENSIONS.includes(ext)) {
    if (!detectDumpMagic(fileBuffer)) {
      return { valid: false, error: 'File does not appear to be a valid Windows dump' };
    }
    return { valid: true };
  }

  if (allowArchives && ARCHIVE_EXTENSIONS.includes(ext)) {
    const archiveType = detectArchiveType(fileBuffer);
    if (!archiveType) {
      return { valid: false, error: 'Archive extension does not match archive signature' };
    }
    return { valid: true };
  }

  return { valid: false, error: 'Unsupported file type' };
}

// Initialize xxhash (awaited before server starts listening)
let hasher;

// Initialize Upstash Redis cache
initCache();

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

function runtimeSessionKey(sessionId) {
  return `session:${sessionId}`;
}

function runtimeSessionHashKey(sessionId, hash) {
  return `session-hash:${sessionId}:${hash}`;
}

function runtimeWinDbgJobKey(uid) {
  return `windbg-job:${uid}`;
}

async function storeSession(sessionId, sessionData) {
  validSessions.set(sessionId, sessionData);
  await setRuntimeValue(runtimeSessionKey(sessionId), sessionData, SESSION_EXPIRY_SECONDS);
}

async function loadSession(sessionId) {
  let sessionData = validSessions.get(sessionId);
  if (sessionData) return sessionData;

  sessionData = await getRuntimeValue(runtimeSessionKey(sessionId));
  if (sessionData) {
    validSessions.set(sessionId, sessionData);
  }
  return sessionData;
}

async function deleteSession(sessionId) {
  validSessions.delete(sessionId);
  sessionHashOwnership.delete(sessionId);
  await deleteRuntimeValue(runtimeSessionKey(sessionId));
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
  await setRuntimeValue(runtimeSessionHashKey(sessionId, hash), { timestamp }, OWNERSHIP_EXPIRY_SECONDS);
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

async function markWinDbgJob(sessionId, uid, fileHash) {
  if (!sessionId || !uid || !fileHash) return;
  const ownership = { sessionId, fileHash, timestamp: Date.now() };
  winDbgJobOwnership.set(uid, ownership);
  await Promise.all([
    setRuntimeValue(runtimeWinDbgJobKey(uid), ownership, OWNERSHIP_EXPIRY_SECONDS),
    markSessionHash(sessionId, fileHash)
  ]);
}

async function sessionOwnsWinDbgJob(sessionId, uid) {
  let job = winDbgJobOwnership.get(uid);
  if (!job) {
    job = await getRuntimeValue(runtimeWinDbgJobKey(uid));
    if (job) winDbgJobOwnership.set(uid, job);
  }
  if (!job || job.sessionId !== sessionId) return false;
  if (Date.now() - job.timestamp > OWNERSHIP_EXPIRY) {
    winDbgJobOwnership.delete(uid);
    await deleteRuntimeValue(runtimeWinDbgJobKey(uid));
    return false;
  }
  return true;
}

// ============================================================
// External API Key Authentication
// ============================================================
const BSOD_API_KEY = process.env.BSOD_API_KEY;
if (!BSOD_API_KEY) {
  console.warn('WARNING: BSOD_API_KEY not configured - external API access disabled');
}

// Multer configuration for file uploads (memory storage for API endpoint)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_RAW_FILE_SIZE,
    files: 1 // Single file only
  },
  fileFilter: (req, file, cb) => {
    // Accept dump files and archives
    const allowedExtensions = [...DUMP_EXTENSIONS, ...ARCHIVE_EXTENSIONS];
    const ext = getFileExtension(file.originalname);
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedExtensions.join(', ')}`));
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
  if (now - _modelCfgCache.readAt < MODEL_CFG_TTL_MS) return _modelCfgCache.value;
  try {
    const modelConfig = fs.readFileSync(MODEL_CFG_PATH, 'utf8').trim();
    if (modelConfig) _modelCfgCache = { value: modelConfig, readAt: now };
    else _modelCfgCache.readAt = now;
  } catch {
    _modelCfgCache.readAt = now; // keep last-good value; don't spam fs errors
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
    return await genAI.models.generateContent(request);
  } catch (err) {
    if (!isModelUnavailableError(err) || request.model === FALLBACK_MODEL) throw err;
    log.warn('gemini.model.fallback', {
      primary: request.model,
      fallback: FALLBACK_MODEL,
      reason: err.message?.slice(0, 200)
    });
    return await genAI.models.generateContent({ ...request, model: FALLBACK_MODEL });
  }
}

// Load SRI mapping if available
let sriMapping = {};
try {
  const sriPath = path.join(__dirname, 'dist', 'sri-mapping.json');
  if (fs.existsSync(sriPath)) {
    sriMapping = JSON.parse(fs.readFileSync(sriPath, 'utf8'));
    console.log('SRI mapping loaded:', Object.keys(sriMapping).length, 'files');
  }
} catch (error) {
  console.log('No SRI mapping found, continuing without integrity checks');
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

// Middleware
// Apply CORS globally (Cloud Run best practice)
app.use(cors(corsOptions));

// Cookie parser middleware
app.use(cookieParser());

// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: SECURITY_CONFIG.api.rateLimiting.windowMs,
  max: SECURITY_CONFIG.api.rateLimiting.maxRequests,
  keyGenerator: rateLimitKey,
  handler: jsonRateLimitHandler,
  message: SECURITY_CONFIG.api.rateLimiting.message,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests to prevent false positives
  skipSuccessfulRequests: false,
  // Explicitly handle the trust proxy configuration
  skip: (req) => {
    // Skip rate limiting for health check endpoint
    return req.path === '/health';
  }
});

const authLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
const cacheLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 120 });
const geminiLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 40 });
const windbgUploadLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
const windbgPollLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 300 });
const archiveLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const externalAnalyzeLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'];
    return apiKey ? `api:${safeToken(apiKey)}` : `ip:${rateLimitKey(req)}`;
  }
});

const geminiConcurrency = createConcurrencyLimiter(8, 'AI_BUSY');
const windbgUploadConcurrency = createConcurrencyLimiter(2, 'WINDBG_UPLOAD_BUSY');
const archiveConcurrency = createConcurrencyLimiter(2, 'ARCHIVE_BUSY');
const externalAnalyzeConcurrency = createConcurrencyLimiter(2, 'ANALYSIS_BUSY');

app.use(compression({
  level: 6, // Compression level 1-9 (6 is good balance)
  threshold: 1024, // Only compress responses above 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Use compression filter
    return compression.filter(req, res);
  }
}));
// Higher limit parser for file upload endpoints (base64-encoded files can be up to 133MB for 100MB files)
const largeJsonParser = express.json({ limit: `${Math.ceil(MAX_UPLOAD_REQUEST_SIZE / 1024 / 1024)}mb` });

// Default JSON parser applied per-route, after rate limit and requireSession,
// so unauthenticated requests are rejected before allocating a parse buffer.
const defaultJsonParser = express.json({ limit: `${Math.ceil(SECURITY_CONFIG.api.maxRequestSize / 1024 / 1024)}mb` });

// Precompute CSP header string once at startup (avoids rebuilding on every request)
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://*.cloudflare.com https://static.cloudflareinsights.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://adnxs.com https://www.paypalobjects.com",
  // AdSense's adsbygoogle.js runtime injects a small container-sizing stylesheet
  // as a data:text/css URL, so 'data:' is required here for ad slots to render.
  "style-src 'self' 'unsafe-inline' data: https://fonts.googleapis.com https://*.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https: blob:",
  "connect-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.gstatic.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://api.claude.ai https://generativelanguage.googleapis.com https://www.paypal.com",
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

app.use(express.static(path.join(__dirname, 'dist'), {
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
      body: formData
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
  validSessions.set(sessionId, sessionData);
  
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
      'localhost',
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


// Helper function to validate that prompts are BSOD-related (prevent API abuse)
// SIMPLIFIED: Focus on blocking obvious abuse, allow all BSOD-related content
function validateBSODPrompt(contents) {
  // Handle both string and array formats
  let promptText;

  if (typeof contents === 'string') {
    // Direct string format
    promptText = contents.toLowerCase();
  } else if (Array.isArray(contents) && contents.length > 0) {
    // Gemini API format: array of content objects
    promptText = contents
      .flatMap(c => c.parts || [])
      .map(p => p.text || '')
      .join(' ')
      .toLowerCase();
  } else {
    console.log('[Validation] FAILED: Invalid contents structure');
    return { valid: false, reason: 'Invalid contents structure' };
  }

  console.log('[Validation] Prompt length:', promptText.length, 'First 100 chars:', promptText.substring(0, 100));

  // Must be substantial prompt (not just "hi" or "test")
  if (promptText.length < 50) {
    console.log('[Validation] FAILED: Prompt too short');
    return { valid: false, reason: 'Prompt too short for crash analysis' };
  }

  // Must contain BSOD/crash analysis keywords (at least ONE)
  const requiredKeywords = [
    'crash dump',
    'windows crash',
    'bug check',
    'bsod',
    'analyzing a windows',
    'kernel debugger',
    'dump file',
    'minidump',
    'memory dump',
    'stop code',
    'exception code',
    'faulting module',
    'windows',
    'crash',
    'dump',
    'error',
    'blue screen',
    'black screen'
  ];

  const hasKeyword = requiredKeywords.some(keyword =>
    promptText.includes(keyword)
  );

  if (!hasKeyword) {
    console.log('[Validation] FAILED: Missing crash analysis keywords');
    return { valid: false, reason: 'Missing crash analysis keywords' };
  }

  console.log('[Validation] Has keyword: true');

  // Reject obvious abuse patterns (simplified)
  const abusePatterns = [
    /write\s+(me\s+)?(a\s+)?(story|poem|essay|song|novel)/i,
    /tell\s+me\s+(a\s+)?(joke|story)/i,
    /translate\s+to\s+/i,
    /ignore\s+(previous|above)\s+instructions/i,
    /forget\s+your\s+instructions/i
  ];

  const matchedPattern = abusePatterns.find(pattern => pattern.test(promptText));
  if (matchedPattern) {
    console.log('[Validation] FAILED: Abuse pattern detected:', matchedPattern);
    return { valid: false, reason: `Abuse pattern detected` };
  }

  console.log('[Validation] PASSED all checks');
  return { valid: true };
}

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
    let sessionTracking = sessionRequestTracking.get(sessionId);

    if (!sessionTracking || now > sessionTracking.resetTime) {
      // Initialize or reset tracking
      sessionTracking = {
        count: 0,
        resetTime: now + (60 * 60 * 1000), // Reset after 1 hour
        totalTokens: 0
      };
      sessionRequestTracking.set(sessionId, sessionTracking);
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

    // Estimate tokens in request (rough estimate: 1 token ≈ 4 characters)
    const requestText = JSON.stringify(contents);
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

    // SECURITY: Validate that prompt is BSOD-related (prevent API abuse)
    const validation = validateBSODPrompt(contents);
    if (!validation.valid) {
      log.warn('prompt.blocked', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        reason: validation.reason,
        promptPreview: JSON.stringify(contents).substring(0, 150)
      });
      return res.status(400).json({
        error: 'Invalid request. This endpoint only analyzes Windows crash dumps and BSOD errors.',
        code: 'INVALID_PROMPT'
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
      log.info('gemini.cache.hit', { keyed: ownedFileHash ? 'fileHash' : 'prompt', fileHash: ownedFileHash ? fileHash : undefined });
      return res.json({
        ...cachedResponse,
        cached: true
      });
    }
    log.info('gemini.cache.miss', { keyed: ownedFileHash ? 'fileHash' : 'prompt', fileHash: ownedFileHash ? fileHash : undefined });

    // Increment request count and token usage
    sessionTracking.count++;
    sessionTracking.totalTokens += estimatedInputTokens;
    
    // Always use the model from config file (re-read with 30s TTL so model.cfg can be
    // swapped at runtime) — ignore any client-provided model for security.
    const modelName = getPrimaryModel();

    // Allowlist client-supplied config fields (camelCase for @google/genai). Anything
    // else — including any 'model' override or stale snake_case keys from pre-migration
    // clients — is silently dropped.
    const frontendConfig = config || generationConfig || {};
    const ALLOWED_CONFIG_KEYS = ['temperature', 'maxOutputTokens', 'topK', 'topP', 'responseMimeType', 'responseSchema', 'stopSequences', 'candidateCount'];
    const sdkConfig = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (frontendConfig[key] !== undefined) sdkConfig[key] = frontendConfig[key];
    }
    if (typeof sdkConfig.maxOutputTokens === 'number') {
      sdkConfig.maxOutputTokens = Math.min(Math.max(Math.floor(sdkConfig.maxOutputTokens), 256), 4096);
    }
    if (typeof sdkConfig.temperature === 'number') {
      sdkConfig.temperature = Math.min(Math.max(sdkConfig.temperature, 0), 1);
    }
    if (typeof sdkConfig.candidateCount === 'number') {
      sdkConfig.candidateCount = 1;
    }
    if (sdkConfig.responseMimeType && sdkConfig.responseMimeType !== 'application/json') {
      delete sdkConfig.responseMimeType;
    }
    if (sdkConfig.responseSchema && JSON.stringify(sdkConfig.responseSchema).length > 32768) {
      delete sdkConfig.responseSchema;
    }

    // SECURITY: enforce BSOD-only analysis (defense-in-depth).
    sdkConfig.systemInstruction = 'You analyze Windows crash dumps (BSOD / kernel) only: bug-check codes, drivers, modules, stacks, kernel debugging. For any other request, respond exactly: "Error: This service only analyzes Windows crash dumps".';

    const response = await generateWithFallback({
      model: modelName,
      contents,
      config: sdkConfig
    });

    // Track real input + output tokens using Gemini's usageMetadata when available;
    // fall back to char/4 only when the API didn't report counts. The new SDK exposes
    // response.text as a getter (not a method).
    const responseText = response.text ?? '';
    const actualInputTokens = response.usageMetadata?.promptTokenCount ?? estimatedInputTokens;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? Math.ceil(responseText.length / 4);
    sessionTracking.totalTokens += actualInputTokens + outputTokens;

    // Log finish reason to diagnose truncation issues
    const finishReason = response.candidates?.[0]?.finishReason || 'UNKNOWN';

    log.info('gemini.request', {
      sessionId: sessionId?.substring(0, 10) + '...',
      model: response.modelVersion || modelName,
      inputTokens: actualInputTokens,
      inputEstimate: estimatedInputTokens,
      outputTokens,
      cachedContentTokens: response.usageMetadata?.cachedContentTokenCount || 0,
      finishReason,
      sessionTotal: sessionTracking.totalTokens,
      requestsRemaining: REQUEST_LIMIT_PER_SESSION - sessionTracking.count
    });

    const responseData = {
      candidates: response.candidates || [{ content: { parts: [{ text: responseText }] } }],
      usageMetadata: response.usageMetadata,
      modelVersion: response.modelVersion,
      text: responseText
    };

    // Cache the response using fileHash if provided
    await setCachedAIReport(cacheKey, responseData);

    res.json(responseData);
  } catch (error) {
    log.error('gemini.error', { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

// ============================================================
// WinDBG Server Proxy Endpoints
// ============================================================

const WINDBG_API_URL = 'https://windbg.stack-tech.net/api';
const WINDBG_API_KEY = process.env.WINDBG_API_KEY;

if (!WINDBG_API_KEY) {
  console.warn('WARNING: WINDBG_API_KEY not configured - WinDBG analysis will fall back to local parsing');
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

    // Check each hash against the combined cache (with legacy fallback).
    // A cache hit means this Turnstile-verified session presented the exact
    // client-side content hash, so allow it to fetch that cached result without
    // re-uploading the dump just to establish ownership.
    const checkPromises = hashesToCheck
      .filter(hash => typeof hash === 'string' && HASH_RE.test(hash))
      .map(async (hash) => {
        const cached = await isAnalysisCached(hash);
        results[hash] = cached;
        if (cached) {
          await markSessionHash(req.sessionId, hash);
        }
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

/**
 * Build multipart form body for WinDBG uploads
 */
function buildWinDBGMultipartBody(apiKey, uid, fileBuffer, fileName) {
  const boundary = '----WinDBGBoundary' + Date.now();
  const CRLF = '\r\n';
  const safeFileName = sanitizeUploadFileName(fileName);

  let body = '';
  body += `--${boundary}${CRLF}`;
  body += `Content-Disposition: form-data; name="APIKEY"${CRLF}${CRLF}`;
  body += `${apiKey}${CRLF}`;
  body += `--${boundary}${CRLF}`;
  body += `Content-Disposition: form-data; name="UID"${CRLF}${CRLF}`;
  body += `${uid}${CRLF}`;

  const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${safeFileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
  const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

  const fullBody = Buffer.concat([
    Buffer.from(body, 'utf8'),
    Buffer.from(fileHeader, 'utf8'),
    fileBuffer,
    Buffer.from(fileFooter, 'utf8')
  ]);

  return { fullBody, boundary };
}

// Upload dump file to WinDBG server
// Uses largeJsonParser to handle base64-encoded files up to 100MB (becomes ~133MB encoded)
app.post('/api/windbg/upload', windbgUploadLimiter, rejectLargeBody(MAX_UPLOAD_REQUEST_SIZE), windbgUploadConcurrency, requireSession, largeJsonParser, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    let { uid, fileData, fileName } = req.body;

    if (!uid || !fileData || !fileName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: uid, fileData, fileName'
      });
    }
    if (typeof uid !== 'string' || !HASH_RE.test(uid) || typeof fileData !== 'string' || typeof fileName !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid upload fields'
      });
    }
    fileName = sanitizeUploadFileName(fileName);

    // Convert base64 file data to buffer
    const fileBuffer = Buffer.from(fileData, 'base64');
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
        data: { uid, queue_position: 0 }
      });
    }

    console.log('[WinDBG] Cache MISS - uploading file:', fileName, 'UID:', uid);

    const { fullBody, boundary } = buildWinDBGMultipartBody(WINDBG_API_KEY, uid, fileBuffer, fileName);
    console.log('[WinDBG] Request body size:', fullBody.length);

    // Upload to WinDBG server
    const response = await fetch(`${WINDBG_API_URL}/upload.php`, {
      method: 'POST',
      body: fullBody,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      }
    });

    // Log response details
    const responseText = await response.text();
    console.log('[WinDBG] Response status:', response.status);
    console.log('[WinDBG] Response body:', responseText.substring(0, 500));

    // Handle 409 - UID already exists (file was previously uploaded)
    // Check if analysis is complete and cache it if so
    if (response.status === 409) {
      console.log('[WinDBG] UID already exists, checking if analysis is complete...');
      await markWinDbgJob(req.sessionId, uid, uid);

      try {
        // Check status on WinDBG server
        const statusUrl = `${WINDBG_API_URL}/status.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;
        const statusResponse = await fetch(statusUrl);

        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          console.log('[WinDBG] Status for existing UID:', statusResult.data?.status);

          // If completed, download and cache the result
          if (statusResult.data?.status === 'completed') {
            console.log('[WinDBG] Analysis already complete, downloading and caching...');
            const downloadUrl = `${WINDBG_API_URL}/download.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;
            const downloadResponse = await fetch(downloadUrl);

            if (downloadResponse.ok) {
              const analysisText = await downloadResponse.text();
              console.log('[WinDBG] Downloaded existing analysis:', analysisText.length, 'bytes');

              // Cache the result
              await setCachedWinDBGAnalysis(uid, {
                windbgOutput: analysisText,
                timestamp: Date.now()
              });

              // Return cached response
              return res.json({
                success: true,
                cached: true,
                cachedAnalysis: analysisText,
                data: { uid, queue_position: 0 }
              });
            }
          }
        }
      } catch (statusError) {
        console.error('[WinDBG] Error checking status for 409:', statusError);
      }

      // If we couldn't get/cache the result, let client poll
      return res.json({
        success: true,
        alreadyExists: true,
        data: { uid, queue_position: 0 }
      });
    }

    if (!response.ok) {
      throw new Error(`WinDBG upload failed with status ${response.status}: ${responseText}`);
    }

    // Parse the response
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Failed to parse WinDBG response: ${responseText}`);
    }
    console.log('[WinDBG] Upload response:', result.success ? 'success' : 'failed');
    if (result.success) {
      await markWinDbgJob(req.sessionId, uid, uid);
    }

    res.json(result);
  } catch (error) {
    log.error('windbg.upload.fail', { message: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload to WinDBG server'
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
    if (!(await sessionOwnsWinDbgJob(req.sessionId, uid))) {
      return res.status(403).json({
        success: false,
        error: 'WinDBG job is not available for this session',
        code: 'WINDBG_FORBIDDEN'
      });
    }

    const statusUrl = `${WINDBG_API_URL}/status.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;
    console.log('[WinDBG] Checking status for UID:', uid);

    const response = await fetch(statusUrl, {
      headers: {
        'Cache-Control': 'no-cache, no-store',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`WinDBG status check failed with status ${response.status}`);
    }

    const result = await response.json();
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
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check WinDBG status'
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
    if (!(await sessionOwnsWinDbgJob(req.sessionId, uid))) {
      return res.status(403).json({
        success: false,
        error: 'WinDBG job is not available for this session',
        code: 'WINDBG_FORBIDDEN'
      });
    }

    const downloadUrl = `${WINDBG_API_URL}/download.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;

    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`WinDBG download failed with status ${response.status}`);
    }

    const analysisText = await response.text();
    console.log('[WinDBG] Downloaded analysis:', analysisText.length, 'bytes');

    // Cache the WinDBG output (UID is the file hash)
    await setCachedWinDBGAnalysis(uid, {
      windbgOutput: analysisText,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      analysisText
    });
  } catch (error) {
    log.error('windbg.download.fail', { message: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to download WinDBG analysis'
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

    // Return extracted files as base64-encoded JSON
    const files = extractedDumps.map(dump => ({
      fileName: dump.fileName,
      data: dump.buffer.toString('base64'),
      size: dump.buffer.length
    }));

    res.json({
      success: true,
      files,
      originalArchive: fileName,
      archiveType
    });
  } catch (error) {
    console.error('[Archive] Extraction error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to extract archive'
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
async function uploadBufferToWinDBG(fileBuffer, fileName, uid) {
  const { fullBody, boundary } = buildWinDBGMultipartBody(WINDBG_API_KEY, uid, fileBuffer, fileName);

  const response = await fetch(`${WINDBG_API_URL}/upload.php`, {
    method: 'POST',
    body: fullBody,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WinDBG upload failed: ${response.status} - ${text}`);
  }

  return await response.json();
}

/**
 * Poll WinDBG server for analysis completion
 */
async function pollWinDBGStatus(uid) {
  let attempts = 0;

  while (attempts < WINDBG_MAX_POLL_ATTEMPTS) {
    attempts++;
    console.log(`[API/WinDBG] Polling status (attempt ${attempts}/${WINDBG_MAX_POLL_ATTEMPTS})...`);

    const statusUrl = `${WINDBG_API_URL}/status.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;
    const response = await fetch(statusUrl, {
      headers: { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
    });

    if (!response.ok) {
      throw new Error(`WinDBG status check failed: ${response.status}`);
    }

    const result = await response.json();
    console.log(`[API/WinDBG] Status: ${result.data?.status}`);

    if (result.data?.status === 'completed') {
      return result;
    }

    if (result.data?.status === 'failed') {
      throw new Error(result.data.error_message || 'WinDBG analysis failed');
    }

    await new Promise(resolve => setTimeout(resolve, WINDBG_POLL_INTERVAL_MS));
  }

  throw new Error('WinDBG analysis timed out');
}

/**
 * Download analysis result from WinDBG server
 */
async function downloadWinDBGAnalysis(uid) {
  const downloadUrl = `${WINDBG_API_URL}/download.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`WinDBG download failed: ${response.status}`);
  }

  return await response.text();
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

async function generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis, fileHash) {
  // Check cache first — prefer stable fileHash; fall back to hashing the analysis text
  const cacheKey = fileHash || windbgAnalysis;
  const cachedReport = await getCachedAIReport(cacheKey);
  if (cachedReport) {
    console.log('[API/AI] Using cached AI report');
    return { ...cachedReport, cached: true };
  }

  console.log('[API/AI] Generating AI report from WinDBG analysis...');

  const analysisForPrompt = extractCrashSignal(windbgAnalysis);
  console.log(`[API/AI] WinDBG signal extracted: ${windbgAnalysis.length} → ${analysisForPrompt.length} chars`);

  const prompt = `You are an expert Windows crash analyst. Analyze this REAL WinDBG output from an actual crash dump analysis and provide a detailed, user-friendly report.

**File Information:**
- Filename: ${fileName}
- Dump Type: ${dumpType}
- File Size: ${fileSize} bytes

**ACTUAL WinDBG Analysis Output:**
\`\`\`
${analysisForPrompt}
\`\`\`

## ANALYSIS REQUIREMENTS

Based on the WinDBG output above, provide:

1. **Summary**: A brief one-sentence summary of what caused the crash
2. **Probable Cause**: A detailed but easy-to-understand explanation of the likely cause
3. **Culprit**: The specific driver or module responsible (extract from WinDBG output)
4. **Recommendations**: Actionable steps the user should take to fix the issue

### IMPORTANT RULES:
- Use ONLY the information from the WinDBG output - this is REAL analysis data
- Extract the actual bug check code, culprit driver, and stack trace from the output
- Do NOT invent or guess information not present in the WinDBG output
- If WinDBG identified a specific driver as the cause, use that as the culprit
- Parse the MODULE_NAME, IMAGE_NAME, and FAILURE_BUCKET_ID from the output

Respond with valid JSON matching this schema:
{
  "summary": "string - one sentence summary",
  "probableCause": "string - detailed explanation",
  "culprit": "string - guilty module/driver",
  "recommendations": ["array of actionable steps"],
  "bugCheck": {
    "code": "string - e.g. 0x0000001A",
    "name": "string - e.g. MEMORY_MANAGEMENT",
    "parameters": ["array of 4 parameter values"]
  },
  "driverWarnings": [{"name": "string", "description": "string", "severity": "critical|warning|info"}],
  "hardwareError": {"type": "string", "details": "string"} or null
}`;

  try {
    const response = await generateWithFallback({
      model: getPrimaryModel(),
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: 4096,
        systemInstruction: 'You are a Windows crash dump analyzer. Provide structured JSON responses only.'
      }
    });
    const responseText = response.text ?? '';

    let report;
    try {
      report = JSON.parse(responseText);
    } catch (parseError) {
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        report = JSON.parse(jsonMatch[0]);
      } else {
        throw parseError;
      }
    }

    // Cache the successful AI report under the stable file hash (or analysis text as fallback)
    await setCachedAIReport(cacheKey, report);
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
      if (fileCount > 20) {
        throw new Error('ZIP contains too many files. Maximum is 20.');
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
          buffer: content,
          originalZip: originalName
        });
      }
    }
  } catch (error) {
    console.error(`[ZIP] Failed to extract from ${originalName}:`, error.message);
    throw new Error(`Failed to extract ZIP: ${error.message}`);
  }

  return results;
}

const ARCHIVE_SIGNATURES = [
  { type: 'zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
  { type: 'zip', bytes: [0x50, 0x4B, 0x05, 0x06] },
  { type: 'zip', bytes: [0x50, 0x4B, 0x07, 0x08] },
  { type: '7z',  bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
  { type: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01] }, // RAR v5
  { type: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00] }, // RAR v4
];

/**
 * Detect archive type from buffer magic bytes
 * @returns 'zip' | '7z' | 'rar' | null
 */
function detectArchiveType(buffer) {
  for (const { type, bytes } of ARCHIVE_SIGNATURES) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) {
      return type;
    }
  }
  return null;
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
    const MAX_FILE_COUNT = 20;
    const MAX_COMPRESSION_RATIO = 100;

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
          const content = fs.readFileSync(fullPath);
          const fileName = sanitizeUploadFileName(entry.name);
          const validation = validateUploadedBuffer(content, fileName, { allowArchives: false });
          if (!validation.valid) {
            console.warn('[Archive] Invalid dump skipped:', validation.error);
            continue;
          }
          results.push({
            fileName,
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
        fileHash
      );

      const processingTime = (Date.now() - startTime) / 1000;
      log.info('analyze.complete', { processingTime, analysisMethod: 'windbg', cached: true, dumpType, fileSize });

      return res.json({
        success: true,
        data: report,
        analysisMethod: 'windbg',
        cached: true,
        processingTime,
        metadata: {
          fileName,
          fileSize,
          dumpType,
          uid: cachedAnalysis.uid,
          originalZip: originalZip || undefined
        }
      });
    }

    console.log('[API/Analyze] Cache MISS - running full WinDBG analysis');

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

    // Generate UID for this analysis
    const uid = generateWinDBGUID();
    console.log(`[API/Analyze] Starting WinDBG analysis with UID: ${uid}`);

    // Create timeout wrapper — track the timer so we can cancel it on success, and
    // swallow the losing branch's rejection to avoid an unhandledRejection.
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Analysis timed out after 5 minutes'));
      }, WINDBG_TOTAL_TIMEOUT_MS);
    });

    // Main analysis pipeline
    const analysisPromise = (async () => {
      // Step 1: Upload to WinDBG
      console.log('[API/Analyze] Step 1: Uploading to WinDBG server...');
      const uploadResult = await uploadBufferToWinDBG(fileBuffer, fileName, uid);
      if (!uploadResult.success) {
        throw new Error(uploadResult.error || 'WinDBG upload failed');
      }
      console.log(`[API/Analyze] Upload successful, queue position: ${uploadResult.data?.queue_position}`);

      // Step 2: Poll for completion
      console.log('[API/Analyze] Step 2: Polling for completion...');
      await pollWinDBGStatus(uid);
      console.log('[API/Analyze] WinDBG analysis completed');

      // Step 3: Download results
      console.log('[API/Analyze] Step 3: Downloading analysis...');
      const windbgAnalysis = await downloadWinDBGAnalysis(uid);
      console.log(`[API/Analyze] Downloaded ${windbgAnalysis.length} bytes of analysis`);

      // Cache the WinDBG analysis for future requests with same file
      await setCachedWinDBGAnalysis(fileHash, {
        windbgOutput: windbgAnalysis,
        uid,
        fileName,
        dumpType,
        timestamp: Date.now()
      });

      // Step 4: Generate AI report
      console.log('[API/Analyze] Step 4: Generating AI report...');
      const report = await generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis, fileHash);

      return {
        report,
        windbgAnalysis,
        analysisMethod: 'windbg'
      };
    })();

    // Race between analysis and timeout. Attach a noop catch to analysisPromise so that
    // if it loses the race and settles later, Node doesn't surface an unhandledRejection.
    analysisPromise.catch(() => {});
    let result;
    try {
      result = await Promise.race([analysisPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const processingTime = (Date.now() - startTime) / 1000;
    log.info('analyze.complete', {
      processingTime,
      analysisMethod: result.analysisMethod,
      dumpType,
      fileSize
    });

    // Return structured response
    res.json({
      success: true,
      data: result.report,
      analysisMethod: result.analysisMethod,
      processingTime,
      metadata: {
        fileName,
        fileSize,
        dumpType,
        uid,
        originalZip: originalZip || undefined
      }
    });

  } catch (error) {
    const processingTime = (Date.now() - startTime) / 1000;
    log.error('analyze.fail', {
      message: error.message,
      processingTime,
      timedOut: /timed out/i.test(error.message || '')
    });

    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
      code: 'ANALYSIS_FAILED',
      processingTime
    });
  }
});

// Catch-all: serve React app for client-side routing
app.use((req, res) => {
  const pathname = req.path;

  // CRITICAL: Don't handle asset files with the catch-all route
  // Static files should be served by express.static middleware
  if (pathname.startsWith('/assets/') ||
      pathname.match(/\.(js|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico|json|xml|txt|webmanifest)$/)) {
    // Return 404 for asset files that weren't found by static middleware
    return res.status(404).send('File not found');
  }

  // Serve React app for all other routes (non-asset routes only)
  // CDN caches 24h (purged on deploy), browser always revalidates
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Link header enables Cloudflare Early Hints (103) for critical assets
  if (earlyHintsLinkHeader) res.setHeader('Link', earlyHintsLinkHeader);
  res.send(cachedIndexHtml);
});

// Cache index.html in memory and ensure xxhash is ready before accepting requests
let cachedIndexHtml;
// Precomputed Link header for Early Hints / Cloudflare preloading
let earlyHintsLinkHeader = '';

async function startServer() {
  // Initialize xxhash before accepting requests
  hasher = await xxhash();
  console.log('XXHash initialized for session management');

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
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
