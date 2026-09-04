# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development
npm run dev              # Start backend (8080) + frontend concurrently
npm run dev:backend      # Start Fastify server only
npm run dev:frontend     # Start Vite dev server only

# Build (client bundle + SSR entry + SRI hashes + per-route prerender)
npm run build
npm run build:no-sri     # Vite client build only
npm run prerender        # Re-run per-route prerender from dist-ssr
npm run verify-hydration # SSR/hydration consistency check

# Test (Node built-in runner, tests/*.test.mjs)
npm test                          # Full suite (~198 tests, no DB/Redis needed)
node --test tests/statsStore.test.mjs   # Single file
node --test tests/foo.test.mjs -t "name pattern"  # Single test by name

# Typecheck / full gate (same as CI)
npm run typecheck        # tsc --noEmit
npm run check            # test + typecheck + build

# Production
npm start                # NODE_ENV=production node server.js

# CSS optimization
npm run analyze-css      # Analyze unused CSS
npm run optimize-css     # Apply CSS purging
```

## Architecture Overview

### System Design

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Browser   │────▶│   Fastify   │────▶│  Gemini API  │
│   (React)   │◀────│   Server    │◀────│  (Google)    │
└─────────────┘     └─────────────┘     └──────────────┘
     Frontend           Backend             AI Service
                          │
                          ▼
                   ┌──────────────┐
                   │ WinDBG Server│
                   │  (Optional)  │
                   └──────────────┘
```

### Backend layering

- **`server.js`** (~4.5K lines) is the route monolith: endpoints are defined
  inline in Express style and run through the **Fastify compatibility layer**
  (`server/fastifyCompat.js`) — `res.set/status/cookie/json/send` emulate
  Express on the raw Node response, with h2c support and compression. The compat
  `res.set` accepts both a headers object and the `(name, value)` pair form.
  `server.js` has no unit tests; testable logic belongs in `server/*.js`
  modules (`statsStore`, `stats`, `quotaPolicy`, `archiveExtract`, `peerIp`,
  `turnstile`, `securityHeaders`, `bugcheckKnowledge`, `fastifyCompat`), which
  the monolith imports.
- **`services/cache.js`** is the only Redis/Upstash boundary for runtime state
  (sessions, jobs, quota counters, leases) plus the analysis cache. Multi-step
  invariants are atomic Lua scripts (`QUOTA_RESERVE_SCRIPT`,
  `QUOTA_REFUND_SCRIPT`) — keep counter clamping, TTL repair, and the refund
  cap inside the scripts, and mirror the semantics in the in-memory fallback
  branches. `services/externalAnalyzeJobs.js` owns the upload→lease→job state
  machine for the external API.
- **Dump parsers** (`utils/`): `dumpParser.ts` orchestrates format dispatch and
  imports `minidumpStreams.ts`, `dumpValidator.ts`,
  `kernelDumpModuleParser.ts`. The import direction never reverses —
  `minidumpStreams.ts` cannot import from `dumpParser.ts` (circular), so gates
  that need `BUG_CHECK_CODES` live in dumpParser. Extraction must be
  evidence-based: bug check codes come from structured dump headers
  (PAGEDU64 @0x38, PAGEDUMP @0x40) or the 0x80000003 BREAKPOINT
  exception-stream convention — never from fixed-offset scans of minidump
  stream metadata (those fabricated STOP codes; tests in
  `tests/dumpParserBugCheck.test.mjs` pin this).

### AI provider chain (server-owned, never client-selected)

`generateAIContent()` in server.js picks per request:

1. `model.cfg` names the primary model (re-read with a 30s cache; currently
   `deepseek-v4-flash`). Gemini models fall back to `gemini-2.5-flash-lite`.
2. DeepSeek requests first try the **OpenAI free tier** (`gpt-5.6-luna`,
   daily data-sharing incentive, metered by the `openai-free:<date>` Redis
   counter); billed-tier responses mark the gate exhausted for the day.
3. Then DeepSeek itself. Fatal DeepSeek failures (out of credits, auth revoked)
   fail over to the **OpenRouter free tier** when `OPENROUTER_API_KEY` is set.
4. All adapters (`services/aiProvider.js`) share the same retry contract:
   transient statuses and transport errors are retried with backoff, the
   network-error latch is cleared on every successful fetch, and responses
   normalize to the Gemini-shaped result (`normalizeAIResponse`).

### Frontend / SSR serving

`npm run build` produces the client bundle, an SSR bundle (`dist-ssr`), and
prerendered HTML per route (`dist/index.prerendered.html`,
`dist/prerendered/<route>.html`). In production the catch-all serves each
route its own prerendered markup from memory with strong ETags (304s on
If-None-Match); in development it reads from disk. Each route must get its own
prerendered markup — never another route's — or hydration mismatches.

### Key Files

- **`server.js`** - Fastify backend with security middleware, session management, rate limiting, Gemini API proxy, and WinDBG proxy
- **`services/geminiProxy.ts`** - Client-side service that routes API calls through backend with session cookies; also builds the analysis prompt (context-scoped redaction) and scrubs the AI report
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

## Testing notes

- Tests use the Node built-in runner (`node:test`) against `tests/*.test.mjs`;
  nothing touches real Redis/Upstash or the network. `npm run check` is what
  CI runs on every push/PR.
- TS sources are loaded in tests via rolldown (a vite dependency):
  single-file `transform('x.ts', source)` for leaf modules
  (`tests/minidumpStreams.test.mjs`), or full bundling with a plugin resolving
  `.js` specifiers back to `.ts` for modules with imports
  (`tests/dumpParserBugCheck.test.mjs`).
- Each fake Redis (e.g. `createFakeRedis` in `tests/statsStore.test.mjs`)
  implements only the operations the store uses — if you add a pipeline
  command to a store, add it to the fake's `pipeline()` too, or calls silently
  return false instead of failing. Beware `resultValue()`: it collapses arrays
  to their first element (it exists for `[value, err]` tuples), so pipeline
  results that are legitimately arrays must be read raw.
- The Lua quota scripts have no test fake; verify script semantics by
  extracting them and running under `lua`/`luac` with a stubbed `redis.call`
  (Upstash is Lua 5.1).

## Security Architecture (6 Layers)

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
| `CACHE_ZSTD_DICTIONARY_PATH` | Binary cache dictionary path (`/secrets/redis-zstd/dictionary` in Cloud Run) | Production |
| `CACHE_ZSTD_WRITES_ENABLED` | Enables dictionary-zstd writes for `analysis:*` only | No; defaults to `false` for staged rollout |
| `REQUIRE_REDIS_RUNTIME` | Require Redis-backed sessions/jobs/limits | Defaults `true` in production |
| `CLOUDFLARE_ONLY_INGRESS` | Reject non-Cloudflare-edge requests with 403 | Defaults `true` in production, `false` otherwise |
| `TRUST_PROXY_HOPS` | Fastify trust-proxy hops (Cloud Run + Cloudflare = 2) | Defaults `2` |
| `STATS_ENABLED` | Crash-statistics recording + `/api/stats` (set `false` to disable) | Defaults on |
| `STATS_SNAPSHOT_TTL_SECONDS` | TTL of the cached public snapshot (`stats:snapshot`) | Defaults `60` |
| `STATS_DAILY_WINDOW_DAYS` | Rolling daily-volume window for crash statistics | Defaults `90` |
| `STATS_INSIGHT_ENABLED` | AI narrative on `/stats` via OpenRouter free model (`OPENROUTER_API_KEY`) | Defaults on; degrades without key |
| `OPENROUTER_API_KEY` | OpenRouter access (AI failover + stats narrative) | Optional secret `openrouter-api-key` |

For local development, set in `.env.local` or export directly. To run with
`NODE_ENV=production` locally, set `CLOUDFLARE_ONLY_INGRESS=false` and
`REQUIRE_REDIS_RUNTIME=false` unless local Redis/Upstash credentials are configured.
Otherwise requests may 403 at ingress checks or startup may fail because the
runtime store is required.

## Deployment

Pushes to `main` automatically deploy to Cloud Run (GitHub Actions CI runs
`npm run check`; a Cloud Build trigger builds and deploys the new revision).
Secrets managed via Google Secret Manager. Use `deploy-with-secret.sh`;
`deploy.sh` is only a compatibility wrapper. Static-only deployment is
unsupported because uploads, archive extraction, WinDBG proxying, AI proxying,
sessions, and rate limits require the Node/Fastify backend.

```bash
# Verify the automatic deploy after pushing to main
gh run list --limit 1                                   # CI status for the commit
gcloud builds list --limit 1                            # build source shows the commit SHA
gcloud run revisions list --service=bsod-analyzer --region=us-east1 --limit=2
curl -s https://bsod.windowsforum.com/health            # expect {"status":"ok","redis":true,...}

# Benchmark/train while the existing analysis cache is still uncompressed
node scripts/cache-zstd-dictionary.mjs
node scripts/cache-zstd-dictionary.mjs --upload --project="$PROJECT_ID"

# Deploy dictionary-aware readers, then explicitly enable writers after checks
CACHE_ZSTD_DICTIONARY_VERSION=NUMERIC_VERSION \
  CACHE_ZSTD_WRITES_ENABLED=false ./deploy-with-secret.sh
CACHE_ZSTD_DICTIONARY_VERSION=NUMERIC_VERSION \
  CACHE_ZSTD_WRITES_ENABLED=true ./deploy-with-secret.sh

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
- **Runtime state**: Keep sessions, ownership, jobs, rate limits, and token accounting Redis-backed in production. Where a process-local Map mirrors Redis state (sessions, WinDBG job ownership), Redis is the authority when `isCacheEnabled()` — read it as such and use compare-and-delete (`deleteRuntimeValueIfEquals`) when expiring shared records, or multi-instance deployments serve stale ownership
- **Cache compression**: Compress only `analysis:*` values. Keep raw binary transport, legacy JSON reads, `runtime:*` serialization, counters, and the seven-day TTL intact
- **Dictionary secrets**: Pin a numeric `redis-zstd-dictionary` version at `/secrets/redis-zstd/dictionary`; never use `latest`, commit the binary, or log its contents
- **Redis flushes**: Never automate a whole-database flush. It is user-owned and also deletes sessions, ownership, jobs, quotas, rate-limit/token counters, and in-flight state

### Session Errors

When users see session errors:
1. Check `handleSessionError()` in `utils/sessionManager.ts` handles the error code
2. Check cookie attributes are consistent across endpoints
