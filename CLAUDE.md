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
  modules (`statsStore`, `stats`, `quotaPolicy`, `quotaStore`, `sessionToken`,
  `rateLimit`, `archiveExtract`, `peerIp`, `turnstile`, `securityHeaders`,
  `bugcheckKnowledge`, `fastifyCompat`), which the monolith imports.
- **`services/cache.js`** is the only Redis/Upstash boundary. Upstash is
  optional (`redis.cfg`/`REDIS_ENABLED`, plus a breaker that drops it on
  quota/auth errors or repeated failures). Session and provider quotas live in
  `server/quotaStore.js` (per-instance; provider budgets split by
  `PROVIDER_QUOTA_SHARDS`). The external API (`/api/analyze`) is stateless:
  `server/externalJobs.js` issues signed job ids carrying the upstream WinDBG
  job id, and any instance resolves a status poll by asking WinDBG directly.
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
2. DeepSeek requests first try **Experiential Cloud** (`gpt-5.6-luna`) when
   `EXPLABS_API_KEY` is bound. `server/quotaStore.js` reserves estimated input
   and output tokens against this instance's share of the provider's
   daily/hourly free-tier limits, then settles to reported usage. Quota/auth
   failures latch for the current window and fall through to the existing
   OpenAI Luna route.
3. The existing **OpenAI free tier** (`gpt-5.6-luna`) remains the next leg,
   gated by the org-wide OpenAI Usage API (a per-instance tally when it is
   unavailable); billed-tier responses latch that gate off for the day.
4. Then DeepSeek itself. Fatal DeepSeek failures (out of credits, auth revoked)
   fail over to the **OpenRouter free tier** when `OPENROUTER_API_KEY` is set.
5. All adapters (`services/aiProvider.js`) share the same retry contract:
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
- Each fake Redis client (e.g. in `tests/cacheIntegration.test.mjs`)
  implements only the operations the code under test uses — add any new
  command to the fake too, or calls silently return nothing instead of failing.
- The Lua lease/job scripts in `services/cache.js` have no test fake; verify
  script semantics by extracting them and running under `lua`/`luac` with a
  stubbed `redis.call` (Upstash is Lua 5.1).

## Security Architecture (6 Layers)

1. **Content Security Policy** - Script validation, no unsafe-eval
2. **Subresource Integrity** - SHA-384 hashes for all assets via `generate-sri.js`
3. **Prompt Validation** - BSOD keyword requirements, abuse pattern blocking
4. **Session Management** - Stateless HMAC-SHA256 signed session cookie (`server/sessionToken.js`), HttpOnly/Secure/SameSite
5. **Rate Limiting** - 50 requests/hour, 100K tokens/hour per session
6. **Cloudflare Turnstile** - Bot protection on session creation

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GEMINI_API_KEY` | Gemini AI API access | Yes |
| `TURNSTILE_SECRET_KEY` | Cloudflare verification | Production |
| `SESSION_SECRET` | Signs session cookies and WinDBG file handles (HKDF key per purpose) | Production |
| `SESSION_SECRET_PREVIOUS` | Old secret still accepted for verification during rotation (never signs) | No |
| `WINDBG_API_KEY` | WinDBG server API access | No (browser path falls back to AI/local evidence) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint for the optional analysis cache | No (cache off without it) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | Production |
| `CACHE_ZSTD_DICTIONARY_PATH` | Binary cache dictionary path (`/secrets/redis-zstd/dictionary` in Cloud Run) | Production |
| `CACHE_ZSTD_WRITES_ENABLED` | Enables dictionary-zstd writes for `analysis:*` only | No; defaults to `false` for staged rollout |
| `REDIS_ENABLED` | Overrides the committed `redis.cfg` switch without a build | No |
| `PROVIDER_QUOTA_SHARDS` | Per-instance share divisor for AI free-tier budgets | Defaults `2` |
| `CLOUDFLARE_ONLY_INGRESS` | Reject non-Cloudflare-edge requests with 403 | Defaults `true` in production, `false` otherwise |
| `TRUST_PROXY_HOPS` | Fastify trust-proxy hops (Cloud Run + Cloudflare = 2) | Defaults `2` |
| `STATS_ENABLED` | Crash-statistics recording + `/api/stats` (set `false` to disable) | Defaults on |
| `STATS_SNAPSHOT_TTL_SECONDS` | In-process memo of the BigQuery-built `/api/stats` snapshot | Defaults `1800` |
| `STATS_BIGQUERY_DATASET` / `STATS_BIGQUERY_TABLE` | Where the `bsod-stats-events` log sink writes `stats.analysis` events | Default `bsod_stats` / `run_googleapis_com_stdout` |
| `STATS_DAILY_WINDOW_DAYS` | Rolling daily-volume window for crash statistics | Defaults `90` |
| `STATS_INSIGHT_ENABLED` | AI narrative on `/stats` via OpenRouter free model (`OPENROUTER_API_KEY`) | Defaults on; degrades without key |
| `OPENROUTER_API_KEY` | OpenRouter access (AI failover + stats narrative) | Optional secret `openrouter-api-key` |

For local development, set in `.env.local` or export directly. To run with
`NODE_ENV=production` locally, set `CLOUDFLARE_ONLY_INGRESS=false` (requests
otherwise 403 at the ingress check) and a `SESSION_SECRET`. Redis is optional;
`/api/stats` needs the Cloud Run metadata server (BigQuery) and answers 503
locally.

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
- **Runtime state**: Correctness must never depend on Upstash (2026-09 outage: the free-tier quota ran out and Redis-required startup took the site down). Anything a follow-up request must trust travels with the client, signed: the session cookie, and the WinDBG file handle (`data.handle` from upload, carrying file ownership + the upstream job id; the client sends it back as `h`/`handles`/`fileHandle`). Rate limits, Turnstile replay and SSO nonces are per-instance memory — Cloud Run session affinity keeps a browser on one instance, and Cloudflare siteverify rejects redeemed Turnstile tokens across instances. Upstash holds only the optional analysis cache (`analysis:*` + `cachemeta:zstd:dictionary:*`); every read fails open, a breaker drops it on quota/auth errors or repeated failures and re-probes later, and its on/off switch is `redis.cfg` (`REDIS_ENABLED` overrides). Crash statistics are logged `stats.analysis` events aggregated in BigQuery (`server/statsBigQuery.js`), not Redis
- **Cache compression**: Compress only `analysis:*` values. Keep raw binary transport, legacy JSON reads, and the seven-day TTL intact
- **Dictionary secrets**: Pin a numeric `redis-zstd-dictionary` version at `/secrets/redis-zstd/dictionary`; never use `latest`, commit the binary, or log its contents
- **Redis flushes**: Never automate a whole-database flush. It is user-owned; it only costs cache misses now, but also drops the pre-cutover `stats:*` counters that `scripts/export-stats-baseline.mjs` exports

### Session Errors

When users see session errors:
1. Check `handleSessionError()` in `utils/sessionManager.ts` handles the error code
2. Check cookie attributes are consistent across endpoints
