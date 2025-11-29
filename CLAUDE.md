# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development
npm run dev              # Start backend (8080) + frontend concurrently
npm run dev:backend      # Start Express server only
npm run dev:frontend     # Start Vite dev server only

# Build
npm run build            # Build production frontend + generate SRI hashes
npm run build:no-sri     # Build without SRI generation

# Production
npm start                # Run production server (NODE_ENV=production)

# CSS optimization
npm run analyze-css      # Analyze unused CSS
npm run optimize-css     # Apply CSS purging
```

## Architecture Overview

### System Design

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Browser   │────▶│   Express   │────▶│  Gemini API  │
│   (React)   │◀────│   Server    │◀────│   (Google)   │
└─────────────┘     └─────────────┘     └──────────────┘
     Frontend           Backend             AI Service
```

### Key Files

- **`server.js`** - Express backend with security middleware, session management, rate limiting, and Gemini API proxy
- **`services/geminiProxy.ts`** - Client-side service that routes API calls through backend with session cookies
- **`utils/sessionManager.ts`** - Client-side session initialization and error handling
- **`serverConfig.js`** - Security configuration constants

### Data Flow

1. User uploads .dmp/.zip files
2. Files categorized as 'minidump' (<5MB) or 'kernel' (≥5MB)
3. Client extracts ASCII/UTF-16LE strings and hex dumps
4. Client sends request with session cookies
5. Backend validates session, rate limits, and prompt content
6. Backend proxies to Gemini API with server-side API key
7. AI analysis returned to client

### Security Architecture (6 Layers)

1. **Content Security Policy** - Script validation, no unsafe-eval
2. **Subresource Integrity** - SHA-384 hashes for all assets via `generate-sri.js`
3. **Prompt Validation** - BSOD keyword requirements, abuse pattern blocking
4. **Session Management** - XXHash session IDs, HttpOnly/Secure/SameSite cookies
5. **Rate Limiting** - 50 requests/hour, 100K tokens/hour per session
6. **Cloudflare Turnstile** - Bot protection on session creation

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GEMINI_API_KEY` | Gemini AI API access | Yes |
| `TURNSTILE_SECRET_KEY` | Cloudflare verification | Production |
| `SESSION_SECRET` | Session security | Production |

For local development, set in `.env.local` or export directly.

## Deployment

Pushes to `main` automatically deploy to Cloud Run. Secrets managed via Google Secret Manager.

```bash
# Manual deploy
./deploy-with-secret.sh

# Update secrets
./setup-all-secrets.sh
./update-turnstile-secret.sh
```

## Key Patterns

### Adding New API Endpoints

1. Add route in `server.js`
2. Apply `requireSession` middleware for protected routes
3. Update client in `services/geminiProxy.ts`

### Modifying Security

- **CSP hashes**: Run `node scripts/hash-inline-scripts.js`
- **SRI hashes**: Auto-generated during `npm run build`
- **Rate limits**: Update in `serverConfig.js` and `server.js` constants

### Session Errors

When users see session errors:
1. Check `handleSessionError()` in `utils/sessionManager.ts` handles the error code
2. Check cookie attributes are consistent across endpoints
