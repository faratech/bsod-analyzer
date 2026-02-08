# BSOD AI Analyzer

Enterprise-grade Windows crash dump analyzer powered by Google's Gemini AI and real WinDBG debugging. Instantly diagnose Blue/Black Screen of Death errors with professional-grade analysis. Supports both classic blue screens and Windows 11's modern black screens.

**Live:** [bsod.windowsforum.com](https://bsod.windowsforum.com)

## Features

- **Real WinDBG Analysis**: Server-side WinDBG debugging with `!analyze -v` on actual crash dumps
- **AI-Powered Reports**: Gemini AI interprets WinDBG output into user-friendly diagnostics
- **Content-Addressed Caching**: XXHash-based deduplication with Upstash Redis — identical dumps return instant results
- **Dual Analysis Paths**: WinDBG server (primary) with client-side binary parsing fallback
- **Multiple Formats**: Supports `.dmp`, `.mdmp`, `.hdmp`, `.kdmp` files and `.zip` archives
- **External API**: REST endpoint for programmatic access with API key authentication
- **6-Layer Security**: CSP, SRI, prompt validation, session management, rate limiting, Cloudflare Turnstile
- **Google Search Grounding**: AI analysis cross-references up-to-date driver and error information

## Quick Start

### Prerequisites

- Node.js 22+
- Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Local Development

```bash
git clone https://github.com/faratech/bsod-analyzer.git
cd bsod-analyzer
npm install

# Create .env.local with your Gemini key
echo "GEMINI_API_KEY=your-gemini-api-key" > .env.local

# Start backend (8080) + frontend concurrently
npm run dev
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend + frontend concurrently |
| `npm run dev:backend` | Start Express server only |
| `npm run dev:frontend` | Start Vite dev server only |
| `npm run build` | Build production frontend + generate SRI hashes |
| `npm run build:no-sri` | Build without SRI generation |
| `npm start` | Run production server (`NODE_ENV=production`) |
| `npm run analyze-css` | Analyze unused CSS |
| `npm run optimize-css` | Apply CSS purging |

## Architecture

### System Overview

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser   │────▶│   Express   │────▶│  Gemini API  │     │ Upstash Redis│
│   (React)   │◀────│   Server    │◀────│   (Google)   │     │   (Cache)    │
└─────────────┘     └──────┬──────┘     └──────────────┘     └──────────────┘
     Frontend              │                 AI Service           Cache Layer
                           │
                           ▼
                    ┌──────────────┐
                    │ WinDBG Server│
                    │  (External)  │
                    └──────────────┘
                     Debug Service
```

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend — security middleware, session management, rate limiting, Gemini API proxy, WinDBG proxy, external API, caching |
| `services/cache.js` | Upstash Redis cache layer for WinDBG analysis and AI reports |
| `services/geminiProxy.ts` | Client-side service routing API calls through backend with session cookies |
| `services/windbgService.ts` | Client-side WinDBG integration (upload, poll, download via backend proxy) |
| `utils/sessionManager.ts` | Client-side session initialization and error handling |
| `serverConfig.js` | Security configuration constants |

### WinDBG Analysis Pipeline

The primary analysis path uses a remote WinDBG server to perform real debugging on crash dumps. This produces professional-grade output identical to running WinDBG locally.

```
User uploads .dmp/.zip
        │
        ▼
  ┌─────────────┐     ┌──────────────┐
  │ Compute file│────▶│ Check Redis  │──── Cache HIT ──▶ Return cached result
  │ XXHash64    │     │ cache by hash│
  └─────────────┘     └──────┬───────┘
                             │ Cache MISS
                             ▼
                    ┌──────────────────┐
                    │ Upload to WinDBG │
                    │ server (base64)  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Poll status every│
                    │ 10s (max 5 min)  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Download WinDBG  │
                    │ analysis output  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Cache WinDBG     │
                    │ output in Redis  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Gemini AI        │
                    │ interprets output│
                    │ into user report │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ Cache AI report  │
                    │ Return to user   │
                    └──────────────────┘
```

**Key details:**
- Files are identified by XXHash64 content hash — uploading the same dump twice hits cache instantly
- WinDBG server upload uses base64-encoded multipart form data proxied through the backend
- Polling uses cache-busting timestamps to prevent browser/CDN caching of status responses
- 5-minute hard timeout wraps the entire pipeline with `Promise.race`
- If WinDBG is unavailable or fails, the client falls back to local binary string extraction + direct Gemini analysis

### Fallback Analysis Path

When the WinDBG server is not configured (`WINDBG_API_KEY` not set) or fails:

1. Client extracts ASCII/UTF-16LE strings and hex dumps from the crash dump locally
2. Extracted data is sent to the backend proxy endpoint
3. Backend validates session, rate limits, and prompt content
4. Backend forwards to Gemini API with server-side API key
5. AI analyzes raw binary data (less accurate than WinDBG output)

### External REST API

A separate `POST /api/analyze` endpoint provides programmatic access:

- Accepts multipart file uploads (`.dmp`, `.zip`)
- Authenticated via `BSOD_API_KEY` header
- Runs the full server-side pipeline: upload → WinDBG → AI report
- Handles ZIP extraction automatically (analyzes first dump found)
- Returns structured JSON with report data, analysis method, and metadata

### Caching Architecture

All caching uses Upstash Redis with content-addressed keys:

| Cache Layer | Key | Value | Purpose |
|-------------|-----|-------|---------|
| WinDBG output | File XXHash64 | Raw WinDBG text + metadata | Skip re-uploading identical dumps |
| AI report | Hash of WinDBG output | Structured report JSON | Skip re-running Gemini for same WinDBG output |
| Combined | File hash | WinDBG + AI report | Client-side cache check before upload |

### Security Architecture (6 Layers)

1. **Content Security Policy** — Script validation via hashes, strict `form-action`, no `unsafe-eval`
2. **Subresource Integrity** — SHA-384 hashes for all production assets via `generate-sri.js`
3. **Prompt Validation** — BSOD keyword requirements, abuse pattern blocking
4. **Session Management** — XXHash session IDs, HttpOnly/Secure/SameSite cookies, 1-hour expiry
5. **Rate Limiting** — 50 requests/hour, 500K tokens/hour per session
6. **Cloudflare Turnstile** — Bot protection on session creation with token replay prevention

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GEMINI_API_KEY` | Gemini AI API access | Yes |
| `WINDBG_API_KEY` | WinDBG server API access | No (falls back to local parsing) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile verification | Production |
| `SESSION_SECRET` | Session cookie signing | Production |
| `BSOD_API_KEY` | External REST API authentication | No (disables `/api/analyze` if unset) |

Upstash Redis credentials are also required for caching (configured via Upstash environment variables).

For local development, set in `.env.local` or export directly.

## Deployment

Pushes to `main` automatically deploy to Cloud Run. Secrets are managed via Google Secret Manager.

### Quick Deploy

```bash
export PROJECT_ID="your-gcp-project-id"

# Create secrets
echo -n "your-gemini-api-key" | gcloud secrets create gemini-api-key --data-file=-

# Deploy
./deploy-with-secret.sh
```

### Manual Deploy

```bash
# Build and push
docker build -t us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest .
docker push us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest

# Deploy to Cloud Run
gcloud run deploy bsod-analyzer \
  --image us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest \
  --region us-east1 \
  --allow-unauthenticated \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

### CI/CD

```bash
# Submit a build
gcloud builds submit --config cloudbuild.yaml

# Set up automatic deployments on push
gcloud builds triggers create github \
  --repo-name=bsod-analyzer \
  --repo-owner=faratech \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

### Secret Management Scripts

- `setup-all-secrets.sh` — Initial setup of all secrets in Google Secret Manager
- `update-turnstile-secret.sh` — Update Turnstile secret when regenerating keys
- `deploy-with-secret.sh` — Deploy to Cloud Run with secrets from Secret Manager

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite |
| Backend | Express.js (ES modules), Node.js 22+ |
| AI | Google Gemini with Search Grounding via `@google/generative-ai` SDK |
| Cache | Upstash Redis (`@upstash/redis`) |
| Hashing | XXHash64 via `xxhash-wasm` (file dedup + sessions) |
| File Processing | FileReader API, JSZip, Multer |
| Markdown | react-markdown with remark-gfm |
| Deployment | Docker, Google Cloud Run, Secret Manager |
| Security | Cloudflare Turnstile, CSP, SRI |

## API Reference

### POST /api/gemini/generateContent

Proxies requests to Google's Gemini API (used by the web UI).

**Requires:** Valid session cookie

### POST /api/analyze

Server-side crash dump analysis (external API).

**Requires:** `x-api-key` header with `BSOD_API_KEY`

**Request:** Multipart form with `file` field (`.dmp` or `.zip`, max 500MB)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": "...",
    "probableCause": "...",
    "culprit": "driver.sys",
    "recommendations": ["..."]
  },
  "analysisMethod": "windbg",
  "cached": false,
  "processingTime": 45.2,
  "metadata": {
    "fileName": "MEMORY.DMP",
    "fileSize": 1048576,
    "dumpType": "kernel",
    "uid": "abc123"
  }
}
```

### WinDBG Proxy Endpoints

These are used internally by the web UI:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/windbg/upload` | POST | Upload dump file to WinDBG server |
| `/api/windbg/status` | GET | Poll analysis status |
| `/api/windbg/download` | GET | Download completed analysis |
| `/api/cache/check` | POST | Check cache status for file hashes |
| `/api/cache/get` | GET | Retrieve cached analysis |
| `/api/cache/set` | POST | Store analysis in cache |

## Troubleshooting

### Common Issues

1. **API Key Errors** — Ensure `GEMINI_API_KEY` is set. For production: `gcloud secrets list`
2. **WinDBG Fallback** — If `WINDBG_API_KEY` is not set, analysis uses client-side binary parsing (less accurate)
3. **Container Failures** — Check logs: `gcloud logging read --limit 50`. Verify PORT=8080
4. **Build Failures** — Ensure Node.js 22+: `node --version`
5. **Session Errors** — Check cookie attributes are consistent; Turnstile must be configured for production

### Monitoring

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=bsod-analyzer" --limit 50
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit changes: `git commit -am 'Add your feature'`
4. Push to branch: `git push origin feature/your-feature`
5. Submit a pull request

Contributions are welcome! By contributing, you agree to license your contributions under the same CC BY 4.0 license.

## Support

For issues and feature requests, please use the [GitHub issue tracker](https://github.com/faratech/bsod-analyzer/issues).

## License

This project is licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

**You are free to:**
- **Share** — copy and redistribute the material in any medium or format
- **Adapt** — remix, transform, and build upon the material for any purpose, even commercially

**Under the following terms:**
- **Attribution** — You must give appropriate credit, provide a link to the license, and indicate if changes were made

**How to Attribute:**
```
BSOD Analyzer by the BSOD Analyzer Contributors, licensed under CC BY 4.0
Source: https://github.com/faratech/bsod-analyzer
```

See the [LICENSE](LICENSE) file for full details.

## Acknowledgments

- Powered by Google Gemini AI for intelligent crash analysis
- WinDBG analysis provided by [stack-tech.net](https://windbg.stack-tech.net)
- Built with React, TypeScript, and Vite
- Deployed on Google Cloud Run
