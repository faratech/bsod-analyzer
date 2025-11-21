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

- **`server.js`** - Express backend with all security middleware, session management, HMAC validation, rate limiting, and Gemini API proxy
- **`services/geminiProxy.ts`** - Client-side service that signs requests with HMAC and routes API calls through backend
- **`utils/sessionManager.ts`** - Client-side session initialization and error handling
- **`serverConfig.js`** - Security configuration constants

### Data Flow

1. User uploads .dmp/.zip files
2. Files categorized as 'minidump' (<5MB) or 'kernel' (≥5MB)
3. Client extracts ASCII/UTF-16LE strings and hex dumps
4. Client signs request with HMAC-SHA256 using session-specific key
5. Backend validates signature, session, rate limits, and prompt content
6. Backend proxies to Gemini API with server-side API key
7. AI analysis returned to client

### Security Architecture (7 Layers)

1. **HMAC Request Signatures** - Client/server HMAC-SHA256 with 5-minute timestamp window
2. **Content Security Policy** - Hash-based script validation, no unsafe-inline/eval
3. **Subresource Integrity** - SHA-384 hashes for all assets via `generate-sri.js`
4. **Prompt Validation** - BSOD keyword requirements, abuse pattern blocking
5. **Session Management** - XXHash session IDs, HttpOnly/Secure/SameSite cookies
6. **Rate Limiting** - 10 requests/hour, 100K tokens/hour per session
7. **Cloudflare Turnstile** - Bot protection on session creation

### Request Signing Flow

Client (`geminiProxy.ts`):
```typescript
const payload = stableStringify(contents) + timestamp;
const signature = HMAC-SHA256(payload, signingKey);
```

Server (`server.js`):
```javascript
const signingKey = HMAC-SHA256(sessionId, SESSION_SECRET);
const expectedSignature = HMAC-SHA256(payload, signingKey);
```

Both use identical `stableStringify()` for canonical JSON serialization with sorted keys.

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
3. Use `validateRequestSignature()` for signed requests
4. Update client in `services/geminiProxy.ts`

### Modifying Security

- **CSP hashes**: Run `node scripts/hash-inline-scripts.js`
- **SRI hashes**: Auto-generated during `npm run build`
- **Rate limits**: Update in `serverConfig.js` and `server.js` constants

### Session/Signature Errors

When users see "Invalid request signature":
1. Check `handleSessionError()` in `utils/sessionManager.ts` handles the error code
2. Verify `stableStringify()` implementations match in client and server
3. Check cookie `partitioned` attribute consistency across endpoints
