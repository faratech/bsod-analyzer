import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { SECURITY_CONFIG } from './serverConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: SECURITY_CONFIG.api.rateLimiting.windowMs,
  max: SECURITY_CONFIG.api.rateLimiting.maxRequests,
  message: SECURITY_CONFIG.api.rateLimiting.message,
  standardHeaders: true,
  legacyHeaders: false,
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
app.use(express.json({ limit: `${SECURITY_CONFIG.api.maxRequestSize}` }));

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

// Static file serving with efficient caching
app.use(express.static(path.join(__dirname, 'dist'), {
  maxAge: '1y', // Cache static assets for 1 year
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Different cache strategies for different file types
    if (filePath.endsWith('.html')) {
      // HTML files - short cache to allow updates
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    } else if (filePath.match(/\.(js|css|woff2|woff|ttf|png|jpg|jpeg|webp|svg|ico)$/)) {
      // Static assets - long cache with fingerprinting
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
    } else if (filePath.endsWith('.json')) {
      // JSON files - medium cache
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    }
    
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
  }
}));

// Initialize Gemini AI with server-side API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Apply rate limiting to API endpoints
app.use('/api/', apiLimiter);

// Proxy endpoint for Gemini API calls
app.post('/api/gemini/generateContent', async (req, res) => {
  try {
    // Validate request size
    const requestSize = JSON.stringify(req.body).length;
    if (requestSize > SECURITY_CONFIG.api.maxRequestSize) {
      return res.status(413).json({ 
        error: `Request too large. Maximum size is ${SECURITY_CONFIG.api.maxRequestSize / 1024 / 1024}MB` 
      });
    }
    const { model, contents, generationConfig, safetySettings, config } = req.body;
    
    // Handle model specification - use the same model as frontend
    const modelName = model || 'gemini-2.5-flash';
    
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
    
    // Copy any other config properties
    Object.keys(frontendConfig).forEach(key => {
      if (key !== 'responseMimeType' && key !== 'responseSchema' && key !== 'temperature') {
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
      modelConfig.tools = tools;
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Handle ?amp=1 parameter for testing AMP pages
app.get('*', (req, res) => {
  const { amp } = req.query;
  const pathname = req.path;
  
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
  
  // Serve React app for all other routes
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API Key configured: ${process.env.GEMINI_API_KEY ? 'Yes' : 'No'}`);
});