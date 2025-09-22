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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers (required for Cloud Run and other reverse proxies)
app.set('trust proxy', true);

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
let DEFAULT_MODEL_NAME = 'gemini-2.5-pro';
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
    
    // Allow any *.windowsforum.com subdomain
    const isWindowsForumDomain = origin && origin.match(/https:\/\/[a-z0-9-]+\.windowsforum\.com$/);
    
    // Allow any bsod-analyzer*.run.app domain
    const isBsodAnalyzerRunApp = origin && origin.match(/https:\/\/bsod-analyzer[a-z0-9-]*\..*\.run\.app$/);
    
    if (allowedOrigins.includes(origin) || isWindowsForumDomain || isBsodAnalyzerRunApp) {
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
app.use(express.json({ limit: '10mb' }));

// Global security headers middleware
app.use((req, res, next) => {
  // Set security headers for all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // Changed from DENY to allow our own frames
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Content Security Policy
  // Note: fenced-frame-src removed as it's not a standard CSP directive
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.cloudflare.com https://*.google.com https://*.googleapis.com https://*.googlesyndication.com https://*.doubleclick.net https://*.googletagmanager.com https://*.google-analytics.com https://*.google https://*.cloudflareinsights.com https://*.gstatic.com https://adnxs.com https://securepubads.g.doubleclick.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://challenges.cloudflare.com https://*.google.com https://*.googleapis.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google-analytics.com https://*.google https://*.cloudflareinsights.com https://api.claude.ai https://generativelanguage.googleapis.com https://www.paypal.com https://csi.gstatic.com",
    "frame-src 'self' https://challenges.cloudflare.com https://*.google.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google https://www.paypal.com https://tpc.googlesyndication.com",
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
  // Handle assets directory specifically
  if (req.path.startsWith('/assets/')) {
    // JavaScript
    if (req.path.endsWith('.js') || req.path.endsWith('.mjs')) {
      res.type('application/javascript');
    }
    // CSS
    else if (req.path.endsWith('.css')) {
      res.type('text/css');
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
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
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
      // HTML files - short cache to allow updates
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
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
  const clientIp = req.ip || req.connection.remoteAddress;
  
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
    const clientIp = req.ip || req.connection.remoteAddress;
    
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
    
    // Add partitioned attribute for CHIPS (Cookies Having Independent Partitioned State)
    if (process.env.NODE_ENV === 'production') {
      cookieOptions.partitioned = true;
    }
    
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
    
    const clientIp = req.ip || req.connection.remoteAddress;
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
    
    // Add partitioned attribute for CHIPS (Cookies Having Independent Partitioned State)
    if (process.env.NODE_ENV === 'production') {
      cookieOptions.partitioned = true;
    }
    
    res.cookie('bsod_session_id', sessionId, cookieOptions);
    res.cookie('bsod_session_hash', sessionHash, cookieOptions);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Session generation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

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
    
    // Handle maxOutputTokens if provided
    if (frontendConfig.maxOutputTokens !== undefined) {
      sdkGenerationConfig.maxOutputTokens = frontendConfig.maxOutputTokens;
    }
    
    // Handle topK if provided
    if (frontendConfig.topK !== undefined) {
      sdkGenerationConfig.topK = frontendConfig.topK;
    }
    
    // Handle topP if provided  
    if (frontendConfig.topP !== undefined) {
      sdkGenerationConfig.topP = frontendConfig.topP;
    }
    
    // Copy any other config properties that might be supported
    const excludedKeys = ['responseMimeType', 'responseSchema', 'temperature', 'maxOutputTokens', 'topK', 'topP'];
    Object.keys(frontendConfig).forEach(key => {
      if (!excludedKeys.includes(key)) {
        sdkGenerationConfig[key] = frontendConfig[key];
      }
    });
    
    // Configure model with tools for grounding
    const modelConfig = {
      model: modelName,
      generationConfig: sdkGenerationConfig,
      safetySettings
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
});
