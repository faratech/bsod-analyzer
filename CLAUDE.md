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
npm test                 # Run Node test suite
npm run typecheck        # Run TypeScript without emitting files
npm run check            # Run tests, typecheck, production build, and SRI generation

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
                          │
                          ▼
                   ┌──────────────┐
                   │ WinDBG Server│
                   │  (Optional)  │
                   └──────────────┘
```

### Key Files

- **`server.js`** - Express backend with security middleware, session management, rate limiting, Gemini API proxy, and WinDBG proxy
- **`services/geminiProxy.ts`** - Client-side service that routes API calls through backend with session cookies
- **`services/windbgService.ts`** - Client-side WinDBG integration (upload, poll, download via backend proxy)
- **`utils/sessionManager.ts`** - Client-side session initialization and error handling
- **`serverConfig.js`** - Security configuration constants

### Data Flow

1. User uploads dump files or `.zip`, `.7z`, `.rar` archives
2. Files categorized as 'minidump' (<5MB) or 'kernel' (≥5MB)
3. **Primary path (WinDBG):** If `WINDBG_API_KEY` is configured:
   - Client uploads file to backend → backend proxies to WinDBG server
   - Backend polls WinDBG status until complete
   - Backend downloads analysis and returns to client
   - AI interprets WinDBG output for user-friendly report
4. **Fallback path:** If WinDBG unavailable or fails:
   - Minidumps use full local parsing, ASCII/UTF-16LE strings, hex evidence, and direct Gemini analysis
   - Large dumps avoid full browser-side parsing and use bounded head/tail sampling for a lightweight AI report
   - Client sends request with session cookies
   - Backend validates session, rate limits, and prompt content
   - Backend proxies to Gemini API with server-side API key
5. AI analysis returned to client

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
| `WINDBG_API_KEY` | WinDBG server API access | No (browser path falls back to AI/local evidence) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint for cache/runtime state | Production |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | Production |
| `REQUIRE_REDIS_RUNTIME` | Require Redis-backed sessions/jobs/limits | Defaults `true` in production |
| `CLOUDFLARE_ONLY_INGRESS` | Reject non-Cloudflare-edge requests with 403 | Defaults `true` in production, `false` otherwise |
| `TRUST_PROXY_HOPS` | Express `trust proxy` hops (Cloud Run + Cloudflare = 2) | Defaults `2` |

For local development, set in `.env.local` or export directly. To run with
`NODE_ENV=production` locally, set `CLOUDFLARE_ONLY_INGRESS=false` and
`REQUIRE_REDIS_RUNTIME=false` unless local Redis/Upstash credentials are configured.
Otherwise requests may 403 at ingress checks or startup may fail because the
runtime store is required.

## Deployment

Pushes to `main` automatically deploy to Cloud Run. Secrets managed via Google Secret Manager.
Use `deploy-with-secret.sh`; `deploy.sh` is only a compatibility wrapper. Static-only
deployment is unsupported because uploads, archive extraction, WinDBG proxying,
AI proxying, sessions, and rate limits require the Node/Express backend.

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
- **Runtime state**: Keep sessions, ownership, jobs, rate limits, and token accounting Redis-backed in production

### Session Errors

When users see session errors:
1. Check `handleSessionError()` in `utils/sessionManager.ts` handles the error code
2. Check cookie attributes are consistent across endpoints
