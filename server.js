import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import xxhash from 'xxhash-wasm';
import { SECURITY_CONFIG } from './serverConfig.js';
import fs from 'fs';
import multer from 'multer';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers (required for Cloud Run)
// Set to 2 to trust both Cloudflare and Cloud Run load balancer
// This ensures req.ip extracts the real client IP from X-Forwarded-For
app.set('trust proxy', 2);

// Helper to get client IP - prefer Cloudflare's header for accuracy
function getClientIp(req) {
  // Cloudflare provides the real client IP in CF-Connecting-IP header
  // This is more reliable than parsing X-Forwarded-For
  return req.headers['cf-connecting-ip'] || req.ip || req.connection.remoteAddress;
}

// Initialize xxhash
let hasher;
xxhash().then(xxhashModule => {
  hasher = xxhashModule;
  console.log('XXHash initialized for session management');
});

// Secret for session validation
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('WARNING: SESSION_SECRET not set - using temporary secret. Sessions will be invalid on restart.');
    // Use a temporary secret to allow the service to start
    const TEMP_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.SESSION_SECRET = TEMP_SECRET;
  }
}
// Use the secret (either from env or temporary)
const ACTUAL_SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Store valid sessions
const validSessions = new Map(); // sessionId -> { hash, timestamp, ip }
const SESSION_EXPIRY = 60 * 60 * 1000; // 1 hour

// Track API requests per session (prevent rapid abuse)
const sessionRequestTracking = new Map(); // sessionId -> { count, resetTime, totalTokens }
const REQUEST_LIMIT_PER_SESSION = 50; // Max 50 requests per hour per session
const TOKEN_LIMIT_PER_SESSION = 500000; // Max ~500K tokens per hour per session (increased for full WinDBG output)

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
    fileSize: 500 * 1024 * 1024, // 500MB max
    files: 1 // Single file only
  },
  fileFilter: (req, file, cb) => {
    // Accept dump files and archives
    const allowedExtensions = ['.dmp', '.mdmp', '.hdmp', '.kdmp', '.zip', '.7z'];
    const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
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
    }
  }
}, 10 * 60 * 1000); // Clean every 10 minutes

// Read model name from config file
let DEFAULT_MODEL_NAME = 'gemini-3-flash-preview';
try {
  const modelConfig = fs.readFileSync(path.join(__dirname, 'model.cfg'), 'utf8').trim();
  if (modelConfig) {
    DEFAULT_MODEL_NAME = modelConfig;
  }
} catch (error) {
  console.log('model.cfg not found or error reading, using default model:', DEFAULT_MODEL_NAME);
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
    
    // Allow file:// protocol origins
    if (origin.startsWith('file://')) {
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
    allowedOrigins.push(
      'https://bsod.windowsforum.com',
      'https://bsod-analyzer-ctlmwtcf5q-ue.a.run.app', // Cloud Run URL
      'https://bsod-analyzer-399450330005.us-east1.run.app' // New Cloud Run URL
    );
    
    // Allow any *.windowsforum.com subdomain (including www.)
    const isWindowsForumDomain = origin && /^https:\/\/(www\.)?([a-z0-9-]+\.)?windowsforum\.com$/i.test(origin);

    // Allow any Cloud Run URL (*.run.app) - we control the deployment
    const isCloudRunApp = origin && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app$/i.test(origin);

    if (allowedOrigins.includes(origin) || isWindowsForumDomain || isCloudRunApp) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
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
const largeJsonParser = express.json({ limit: '150mb' });

// Default JSON body limit for most API endpoints
// Skip for routes that need larger payloads (they use largeJsonParser directly)
app.use((req, res, next) => {
  if (req.path === '/api/windbg/upload') {
    return next(); // Skip default parser, route will use largeJsonParser
  }
  express.json({ limit: '10mb' })(req, res, next);
});

// Global security headers middleware
app.use((req, res, next) => {
  // Set security headers for all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // Changed from DENY to allow our own frames
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Content Security Policy
  // SECURITY: Strict CSP with hash-based script validation
  // Inline script hashes generated by hash-inline-scripts.js
  const cspDirectives = [
    "default-src 'self'",
    // CRITICAL: Script integrity enforcement
    // - 'self': Allow scripts from same origin
    // - sha256-...: Hashes for inline scripts (Google Analytics, AdSense loaders)
    // - Third-party: Google services (Analytics, Ads, Tag Manager, Turnstile)
    // - NO 'unsafe-inline' or 'unsafe-eval' - all scripts must be hashed or from trusted sources
    "script-src 'self' 'unsafe-inline' https://*.cloudflare.com https://static.cloudflareinsights.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://adnxs.com",
    // Styles: Allow inline for React/Tailwind (future: move to hash-based)
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://api.claude.ai https://generativelanguage.googleapis.com https://www.paypal.com",
    "frame-src 'self' https://challenges.cloudflare.com https://*.google https://*.google.com https://*.googletagmanager.com https://*.googlesyndication.com https://*.doubleclick.net https://www.paypal.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests"
  ];
  
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
  
  // Add CORP header to prevent opaque response blocking
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  
  // Add COOP for better security isolation
  // Note: COEP is disabled to allow AdSense and other third-party resources
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless'); // Disabled for AdSense compatibility
  
  next();
});

// CRITICAL: Set MIME types for assets BEFORE any other middleware
// This ensures Cloud Run serves files with correct Content-Type
app.use((req, res, next) => {
  // Log asset requests for debugging
  if (req.path.startsWith('/assets/')) {
    console.log(`Asset request: ${req.path}`);
  }

  // Handle assets directory specifically
  if (req.path.startsWith('/assets/')) {
    // JavaScript
    if (req.path.endsWith('.js') || req.path.endsWith('.mjs')) {
      res.type('application/javascript');
      console.log(`Setting JS MIME type for: ${req.path}`);
    }
    // CSS
    else if (req.path.endsWith('.css')) {
      res.type('text/css');
      console.log(`Setting CSS MIME type for: ${req.path}`);
    }
    // Fonts
    else if (req.path.endsWith('.woff2')) {
      res.type('font/woff2');
    }
    else if (req.path.endsWith('.woff')) {
      res.type('font/woff');
    }
    else if (req.path.endsWith('.ttf')) {
      res.type('font/ttf');
    }
    else if (req.path.endsWith('.otf')) {
      res.type('font/otf');
    }
    // Images
    else if (req.path.endsWith('.png')) {
      res.type('image/png');
    }
    else if (req.path.endsWith('.jpg') || req.path.endsWith('.jpeg')) {
      res.type('image/jpeg');
    }
    else if (req.path.endsWith('.webp')) {
      res.type('image/webp');
    }
    else if (req.path.endsWith('.svg')) {
      res.type('image/svg+xml');
    }
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

// Static file serving with explicit MIME types and efficient caching
app.use(express.static(path.join(__dirname, 'dist'), {
  maxAge: '1y', // Cache static assets for 1 year
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // CRITICAL: Set MIME types FIRST before any other headers
    // This ensures Cloud Run doesn't override them

    // JavaScript files - MUST be set correctly for Cloud Run
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff'); // Prevent MIME sniffing
    }

    // CSS files - MUST be set correctly for Cloud Run
    else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff'); // Prevent MIME sniffing
    }

    // HTML files
    else if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, must-revalidate'); // Always revalidate HTML
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // JSON files
    else if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
      // Allow cross-origin for symbol files
      if (filePath.includes('/symbols/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
    }

    // Web fonts
    else if (filePath.endsWith('.woff2')) {
      res.setHeader('Content-Type', 'font/woff2');
    } else if (filePath.endsWith('.woff')) {
      res.setHeader('Content-Type', 'font/woff');
    } else if (filePath.endsWith('.ttf')) {
      res.setHeader('Content-Type', 'font/ttf');
    } else if (filePath.endsWith('.otf')) {
      res.setHeader('Content-Type', 'font/otf');
    } else if (filePath.endsWith('.eot')) {
      res.setHeader('Content-Type', 'application/vnd.ms-fontobject');
    }

    // Images
    else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (filePath.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/webp');
    } else if (filePath.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (filePath.endsWith('.ico')) {
      res.setHeader('Content-Type', 'image/x-icon');
    }

    // Set cache headers AFTER MIME types
    if (filePath.endsWith('.html')) {
      // HTML files - always revalidate to ensure users get latest bundle references
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.match(/\.(js|mjs|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico)$/)) {
      // Static assets - long cache with fingerprinting
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
    } else if (filePath.endsWith('.json')) {
      // JSON files - medium cache
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    }

    // Allow CORS for fonts and certain resources
    if (filePath.match(/\.(woff2|woff|ttf|otf|eot)$/)) {
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
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

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

  if (!token) {
    return { 
      success: false, 
      'error-codes': ['missing-input-response'],
      error: 'No token provided' 
    };
  }

  // Check if token was already used (prevent replay attacks)
  if (usedTurnstileTokens.has(token) && !idempotencyKey) {
    console.warn('Turnstile token already used:', token.substring(0, 20) + '...');
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

// Generate session cookie
function generateSessionCookie(ip) {
  if (!hasher) {
    console.error('XXHash not initialized when trying to generate session');
    throw new Error('XXHash not initialized');
  }
  
  const sessionId = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const dataToHash = `${sessionId}:${timestamp}:${ip}:${ACTUAL_SESSION_SECRET}`;
  const sessionHash = hasher.h64ToString(dataToHash);
  
  // Store session
  validSessions.set(sessionId, {
    hash: sessionHash,
    timestamp,
    ip
  });
  
  return {
    sessionId,
    sessionHash
  };
}

// Validate session cookie
function validateSession(sessionId, sessionHash, ip) {
  const sessionData = validSessions.get(sessionId);
  
  if (!sessionData) {
    return { valid: false, reason: 'Session not found' };
  }
  
  // Check expiry
  if (Date.now() - sessionData.timestamp > SESSION_EXPIRY) {
    validSessions.delete(sessionId);
    return { valid: false, reason: 'Session expired' };
  }
  
  // Verify IP matches
  if (sessionData.ip !== ip) {
    return { valid: false, reason: 'IP mismatch' };
  }
  
  // Verify hash
  if (sessionData.hash !== sessionHash) {
    return { valid: false, reason: 'Invalid session hash' };
  }
  
  return { valid: true };
}

// Middleware to validate session for analyzer API
const requireSession = (req, res, next) => {
  const sessionId = req.cookies.bsod_session_id;
  const sessionHash = req.cookies.bsod_session_hash;
  const clientIp = getClientIp(req);
  
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
    return res.status(401).json({ error: 'Session required', code: 'NO_SESSION' });
  }
  
  const validation = validateSession(sessionId, sessionHash, clientIp);
  if (!validation.valid) {
    console.log('Session validation failed:', {
      reason: validation.reason,
      sessionId: sessionId.substring(0, 10) + '...',
      clientIp
    });
    return res.status(401).json({ error: validation.reason, code: 'INVALID_SESSION' });
  }
  
  // Refresh session timestamp
  const sessionData = validSessions.get(sessionId);
  sessionData.timestamp = Date.now();

  next();
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

  if (apiKey !== BSOD_API_KEY) {
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
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!genAI,
      turnstile: !!TURNSTILE_SECRET_KEY,
      session: !!ACTUAL_SESSION_SECRET
    }
  });
});

// Apply rate limiting to API endpoints
app.use('/api/', apiLimiter);

// Endpoint to verify Turnstile and create session
app.post('/api/auth/verify-turnstile', async (req, res) => {
  try {
    const { token, action, cdata } = req.body;
    const clientIp = getClientIp(req);
    
    // Generate idempotency key for this request
    const idempotencyKey = crypto.randomUUID();
    
    // Verify the Turnstile token with Siteverify
    const verification = await verifyTurnstileToken(token, clientIp, idempotencyKey);
    
    if (!verification.success) {
      // Log detailed error for debugging
      console.error('Turnstile Siteverify failed:', {
        'error-codes': verification['error-codes'],
        clientIp,
        tokenPrefix: token ? token.substring(0, 20) + '...' : 'none'
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
    
    // Validate expected action if provided
    if (action && verification.action !== action) {
      console.warn('Turnstile action mismatch:', {
        expected: action,
        received: verification.action
      });
    }
    
    // Validate hostname matches expected domain
    const expectedHostnames = [
      'localhost',
      'bsod.windowsforum.com',
      process.env.ALLOWED_HOSTNAME
    ].filter(Boolean);
    
    if (verification.hostname && !expectedHostnames.includes(verification.hostname)) {
      console.warn('Unexpected hostname in Turnstile response:', verification.hostname);
    }
    
    // If verification successful, create session
    const { sessionId, sessionHash } = generateSessionCookie(clientIp);
    
    // Set secure cookies with modern attributes
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', // Changed from 'strict' to allow cookies on navigation
      maxAge: SESSION_EXPIRY,
      path: '/', // Ensure cookies are available for all paths
      // Don't set domain - let browser handle it to work with any domain
    };

    res.cookie('bsod_session_id', sessionId, cookieOptions);
    res.cookie('bsod_session_hash', sessionHash, cookieOptions);
    res.cookie('bsod_turnstile_verified', 'true', { ...cookieOptions, maxAge: 2 * 60 * 60 * 1000 }); // 2 hours
    
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

// Endpoint to get session cookie (called when user visits analyzer page)
app.get('/api/auth/session', async (req, res) => {
  try {
    // Ensure XXHash is initialized
    if (!hasher) {
      console.log('Waiting for XXHash to initialize...');
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!hasher) {
        return res.status(503).json({ error: 'Session service not ready' });
      }
    }
    // Temporarily disabled Turnstile check to debug session issues
    // TODO: Re-enable after fixing session validation
    /*
    if (process.env.NODE_ENV === 'production') {
      const turnstileVerified = req.cookies.bsod_turnstile_verified;
      if (!turnstileVerified) {
        // Don't create a session without Turnstile verification in production
        return res.status(403).json({ 
          error: 'Turnstile verification required', 
          code: 'TURNSTILE_REQUIRED' 
        });
      }
    }
    */

    const clientIp = getClientIp(req);
    const { sessionId, sessionHash } = generateSessionCookie(clientIp);
    
    console.log('Creating session:', {
      sessionIdPrefix: sessionId.substring(0, 10) + '...',
      clientIp,
      cookieDomain: req.get('host')
    });
    
    // Set secure cookies with modern attributes
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', // Changed from 'strict' to allow cookies on navigation
      maxAge: SESSION_EXPIRY,
      path: '/', // Ensure cookies are available for all paths
      // Don't set domain - let browser handle it to work with any domain
    };
    
    res.cookie('bsod_session_id', sessionId, cookieOptions);
    res.cookie('bsod_session_hash', sessionHash, cookieOptions);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Session generation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
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
app.post('/api/gemini/generateContent', requireSession, async (req, res) => {
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
    const { contents, generationConfig, safetySettings, config } = req.body;
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
      console.warn('[Security] Per-session rate limit exceeded:', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        requestCount: sessionTracking.count,
        resetTime: new Date(sessionTracking.resetTime).toISOString()
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
      console.warn('[Security] Per-session token limit exceeded:', {
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
      console.warn('[Security] Non-BSOD prompt blocked:', {
        sessionId: sessionId?.substring(0, 10) + '...',
        ip: getClientIp(req),
        reason: validation.reason,
        promptPreview: JSON.stringify(contents).substring(0, 150) + '...'
      });
      return res.status(400).json({
        error: 'Invalid request. This endpoint only analyzes Windows crash dumps and BSOD errors.',
        code: 'INVALID_PROMPT'
      });
    }

    // Increment request count and token usage
    sessionTracking.count++;
    sessionTracking.totalTokens += estimatedInputTokens;

    // Debug logging
    console.log('[Gemini API] Request received with contents type:', typeof contents);
    if (typeof contents === 'object') {
      console.log('[Gemini API] Contents structure:', JSON.stringify(contents).substring(0, 200) + '...');
    }
    
    // Always use the model from config file - ignore any client-provided model
    const modelName = DEFAULT_MODEL_NAME;
    
    // Extract configuration - frontend sends 'config', SDK expects 'generationConfig'
    const frontendConfig = config || generationConfig || {};
    
    // Build proper generationConfig for the SDK
    const sdkGenerationConfig = {};
    
    // Handle response_mime_type (correct field name for the SDK)
    if (frontendConfig.responseMimeType) {
      sdkGenerationConfig.response_mime_type = frontendConfig.responseMimeType;
    }
    
    // Handle response_schema (correct field name for the SDK)
    if (frontendConfig.responseSchema) {
      sdkGenerationConfig.response_schema = frontendConfig.responseSchema;
    }
    
    // Handle temperature if provided
    if (frontendConfig.temperature !== undefined) {
      sdkGenerationConfig.temperature = frontendConfig.temperature;
    }
    
    // Handle maxOutputTokens if provided (use snake_case for SDK consistency)
    if (frontendConfig.maxOutputTokens !== undefined) {
      sdkGenerationConfig.max_output_tokens = frontendConfig.maxOutputTokens;
    }
    
    // Handle topK if provided (use snake_case for SDK consistency)
    if (frontendConfig.topK !== undefined) {
      sdkGenerationConfig.top_k = frontendConfig.topK;
    }

    // Handle topP if provided (use snake_case for SDK consistency)
    if (frontendConfig.topP !== undefined) {
      sdkGenerationConfig.top_p = frontendConfig.topP;
    }
    
    // Copy any other config properties that might be supported
    // SECURITY: Explicitly exclude 'model' to prevent client from overriding server model selection
    const excludedKeys = ['responseMimeType', 'responseSchema', 'temperature', 'maxOutputTokens', 'topK', 'topP', 'model'];
    Object.keys(frontendConfig).forEach(key => {
      if (!excludedKeys.includes(key)) {
        sdkGenerationConfig[key] = frontendConfig[key];
      }
    });
    
    // Configure model with tools for grounding
    const modelConfig = {
      model: modelName,
      generationConfig: sdkGenerationConfig,
      safetySettings,
      // SECURITY: Add system instruction to enforce BSOD-only analysis (defense-in-depth)
      systemInstruction: {
        role: "system",
        parts: [{
          text: `You are a Windows crash dump analyzer and kernel debugger assistant. You MUST ONLY analyze crash dumps and BSOD errors.

STRICT OPERATIONAL RULES:
- ONLY respond to Windows crash dump analysis requests
- ONLY discuss: bug check codes, drivers, memory dumps, stack traces, Windows kernel debugging
- REJECT any requests for: stories, poems, code generation, translations, general questions, homework help
- If the request is not about Windows crash analysis, respond: "Error: This service only analyzes Windows crash dumps"

Your expertise is limited to:
✓ Bug check codes and parameters
✓ Driver and module analysis
✓ Memory dump interpretation
✓ Stack trace analysis
✓ Windows kernel debugging
✓ System crash diagnostics

You do NOT provide assistance with any other topics.`
        }]
      }
    };
    
    // Add grounding tools configuration
    const tools = req.body.tools || [];
    if (tools.length > 0) {
      // Ensure tools are properly formatted for the API
      modelConfig.tools = tools.map(tool => {
        // Handle Google Search grounding tool
        if (tool.googleSearch || tool.google_search_retrieval) {
          return {
            googleSearchRetrieval: tool.googleSearch || tool.google_search_retrieval || {}
          };
        }
        return tool;
      });
    }
    
    const geminiModel = genAI.getGenerativeModel(modelConfig);

    const result = await geminiModel.generateContent(contents);
    const response = await result.response;

    // Track output tokens for cost control
    const outputTokens = response.usageMetadata?.candidatesTokenCount || Math.ceil(response.text().length / 4);
    sessionTracking.totalTokens += outputTokens;

    // Log finish reason to diagnose truncation issues
    const finishReason = response.candidates?.[0]?.finishReason || 'UNKNOWN';

    console.log('[Gemini API] Request completed:', {
      sessionId: sessionId?.substring(0, 10) + '...',
      inputTokens: estimatedInputTokens,
      outputTokens: outputTokens,
      finishReason: finishReason,
      sessionTotal: sessionTracking.totalTokens,
      requestsRemaining: REQUEST_LIMIT_PER_SESSION - sessionTracking.count
    });

    // Return the text directly for compatibility
    const text = response.text();

    res.json({
      candidates: response.candidates || [{ content: { parts: [{ text }] } }],
      usageMetadata: response.usageMetadata,
      modelVersion: response.modelVersion,
      text // Include text for easier access
    });
  } catch (error) {
    console.error('Gemini API error:', error);
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

// Upload dump file to WinDBG server
// Uses largeJsonParser to handle base64-encoded files up to 100MB (becomes ~133MB encoded)
app.post('/api/windbg/upload', largeJsonParser, requireSession, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    const { uid, fileData, fileName } = req.body;

    if (!uid || !fileData || !fileName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: uid, fileData, fileName'
      });
    }

    // Convert base64 file data to buffer
    const fileBuffer = Buffer.from(fileData, 'base64');

    console.log('[WinDBG] Uploading file:', fileName, 'Size:', fileBuffer.length, 'UID:', uid);

    // Build multipart form data manually for compatibility with Node.js fetch
    const boundary = '----WinDBGBoundary' + Date.now();
    const CRLF = '\r\n';

    // Build the multipart body
    let body = '';

    // APIKEY field
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="APIKEY"${CRLF}${CRLF}`;
    body += `${WINDBG_API_KEY}${CRLF}`;

    // UID field
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="UID"${CRLF}${CRLF}`;
    body += `${uid}${CRLF}`;

    // File field - need to handle binary data
    const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
    const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

    // Combine all parts into final body
    const preFileBuffer = Buffer.from(body, 'utf8');
    const fileHeaderBuffer = Buffer.from(fileHeader, 'utf8');
    const fileFooterBuffer = Buffer.from(fileFooter, 'utf8');

    const fullBody = Buffer.concat([
      preFileBuffer,
      fileHeaderBuffer,
      fileBuffer,
      fileFooterBuffer
    ]);

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

    res.json(result);
  } catch (error) {
    console.error('[WinDBG] Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload to WinDBG server'
    });
  }
});

// Poll WinDBG status
app.get('/api/windbg/status', requireSession, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: uid'
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
app.get('/api/windbg/download', requireSession, async (req, res) => {
  try {
    if (!WINDBG_API_KEY) {
      return res.status(503).json({
        success: false,
        error: 'WinDBG service not configured'
      });
    }

    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: uid'
      });
    }

    const downloadUrl = `${WINDBG_API_URL}/download.php?APIKEY=${encodeURIComponent(WINDBG_API_KEY)}&UID=${encodeURIComponent(uid)}`;

    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`WinDBG download failed with status ${response.status}`);
    }

    const analysisText = await response.text();
    console.log('[WinDBG] Downloaded analysis:', analysisText.length, 'bytes');

    res.json({
      success: true,
      analysisText
    });
  } catch (error) {
    console.error('[WinDBG] Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to download WinDBG analysis'
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
  const random = Math.random().toString(36).substring(2, 8);
  return `API-${timestamp}-${random}`;
}

/**
 * Upload file buffer to WinDBG server
 */
async function uploadBufferToWinDBG(fileBuffer, fileName, uid) {
  const boundary = '----WinDBGBoundary' + Date.now();
  const CRLF = '\r\n';

  let body = '';
  body += `--${boundary}${CRLF}`;
  body += `Content-Disposition: form-data; name="APIKEY"${CRLF}${CRLF}`;
  body += `${WINDBG_API_KEY}${CRLF}`;
  body += `--${boundary}${CRLF}`;
  body += `Content-Disposition: form-data; name="UID"${CRLF}${CRLF}`;
  body += `${uid}${CRLF}`;

  const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
  const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

  const preFileBuffer = Buffer.from(body, 'utf8');
  const fileHeaderBuffer = Buffer.from(fileHeader, 'utf8');
  const fileFooterBuffer = Buffer.from(fileFooter, 'utf8');

  const fullBody = Buffer.concat([
    preFileBuffer,
    fileHeaderBuffer,
    fileBuffer,
    fileFooterBuffer
  ]);

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
 */
async function generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis) {
  console.log('[API/AI] Generating AI report from WinDBG analysis...');

  const prompt = `You are an expert Windows crash analyst. Analyze this REAL WinDBG output from an actual crash dump analysis and provide a detailed, user-friendly report.

**File Information:**
- Filename: ${fileName}
- Dump Type: ${dumpType}
- File Size: ${fileSize} bytes

**ACTUAL WinDBG Analysis Output:**
\`\`\`
${windbgAnalysis}
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
    const modelConfig = {
      model: DEFAULT_MODEL_NAME,
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.5,
        max_output_tokens: 4096
      },
      systemInstruction: {
        role: "system",
        parts: [{
          text: "You are a Windows crash dump analyzer. Provide structured JSON responses only."
        }]
      }
    };

    const geminiModel = genAI.getGenerativeModel(modelConfig);
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text();

    try {
      return JSON.parse(responseText);
    } catch (parseError) {
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw parseError;
    }
  } catch (error) {
    console.error('[API/AI] AI analysis error:', error);
    // Return basic report if AI fails
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
const DUMP_EXTENSIONS = ['.dmp', '.mdmp', '.hdmp', '.kdmp'];

async function extractDumpsFromZip(zipBuffer, originalName) {
  const results = [];

  try {
    const zip = await JSZip.loadAsync(zipBuffer);

    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;

      const lowerPath = path.toLowerCase();
      const isDump = DUMP_EXTENSIONS.some(ext => lowerPath.endsWith(ext));

      if (isDump) {
        const content = await file.async('nodebuffer');
        const fileName = path.split('/').pop();
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

function isZipFile(buffer) {
  return buffer.length >= 4 &&
         buffer[0] === 0x50 && buffer[1] === 0x4B &&
         buffer[2] === 0x03 && buffer[3] === 0x04;
}

// Main external API endpoint
app.post('/api/analyze', requireApiKey, upload.single('file'), async (req, res) => {
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
    let fileName = req.file.originalname || 'upload.dmp';
    const originalFileSize = fileBuffer.length;
    let originalZip = null;

    console.log(`[API/Analyze] Received file: ${fileName} (${originalFileSize} bytes)`);

    // Check if file is a ZIP archive
    if (isZipFile(fileBuffer)) {
      console.log(`[API/Analyze] Detected ZIP archive, extracting dumps...`);
      const extractedDumps = await extractDumpsFromZip(fileBuffer, fileName);

      if (extractedDumps.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No dump files (.dmp, .mdmp, .hdmp, .kdmp) found in ZIP archive',
          code: 'NO_DUMPS_IN_ZIP'
        });
      }

      // Use the first dump found (could enhance to analyze all)
      const firstDump = extractedDumps[0];
      console.log(`[API/Analyze] Found ${extractedDumps.length} dump(s), analyzing: ${firstDump.fileName}`);
      originalZip = fileName;
      fileName = firstDump.fileName;
      fileBuffer = firstDump.buffer;
    }

    const fileSize = fileBuffer.length;

    // Detect dump type
    const dumpType = detectDumpType(fileBuffer);
    console.log(`[API/Analyze] Detected dump type: ${dumpType}`);

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

    // Create timeout wrapper
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
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

      // Step 4: Generate AI report
      console.log('[API/Analyze] Step 4: Generating AI report...');
      const report = await generateAIReportFromWinDBG(fileName, dumpType, fileSize, windbgAnalysis);

      return {
        report,
        windbgAnalysis,
        analysisMethod: 'windbg'
      };
    })();

    // Race between analysis and timeout
    const result = await Promise.race([analysisPromise, timeoutPromise]);

    const processingTime = (Date.now() - startTime) / 1000;
    console.log(`[API/Analyze] Analysis completed in ${processingTime}s`);

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
    console.error('[API/Analyze] Error:', error);

    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
      code: 'ANALYSIS_FAILED',
      processingTime
    });
  }
});

// Handle ?amp=1 parameter for testing AMP pages
// Use a function instead of '*' to avoid path-to-regexp issues
app.use((req, res) => {
  const { amp } = req.query;
  const pathname = req.path;

  // CRITICAL: Don't handle asset files with the catch-all route
  // Static files should be served by express.static middleware
  if (pathname.startsWith('/assets/') ||
      pathname.match(/\.(js|css|woff2|woff|ttf|otf|eot|png|jpg|jpeg|webp|svg|ico|json|xml|txt|webmanifest)$/)) {
    // Return 404 for asset files that weren't found by static middleware
    return res.status(404).send('File not found');
  }

  // If ?amp=1 is present, redirect to AMP version
  if (amp === '1') {
    let ampPath;
    if (pathname === '/') {
      ampPath = '/amp/index.html';
    } else if (pathname === '/about') {
      ampPath = '/amp/about.html';
    } else if (pathname === '/documentation') {
      ampPath = '/amp/documentation.html';
    } else if (pathname === '/donate') {
      ampPath = '/amp/donate.html';
    } else {
      // Default to home AMP page for unknown routes
      ampPath = '/amp/index.html';
    }

    return res.redirect(302, ampPath);
  }

  // Serve static AMP files directly
  if (pathname.startsWith('/amp/')) {
    const ampFile = path.join(__dirname, pathname);
    return res.sendFile(ampFile, (err) => {
      if (err) {
        res.status(404).send('AMP page not found');
      }
    });
  }

  // Serve React app for all other routes (non-asset routes only)
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API Key configured: ${process.env.GEMINI_API_KEY ? 'Yes' : 'No'}`);
  console.log(`Turnstile Secret Key configured: ${TURNSTILE_SECRET_KEY ? 'Yes' : 'No'}`);
  console.log(`WinDBG API Key configured: ${WINDBG_API_KEY ? 'Yes' : 'No'}`);
});
