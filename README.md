# 💥 BSOD AI Analyzer

Drop in a Windows crash dump, get a plain-English answer. The analyzer runs **real WinDBG** (`!analyze -v`) on your dump, then an AI model turns the debugger output into a friendly report: what crashed, the likely culprit, and what to do next.

🌐 **Live:** [bsod.windowsforum.com](https://bsod.windowsforum.com) · 📊 [Crash statistics](https://bsod.windowsforum.com/stats) · 🔒 [Privacy & data use](https://bsod.windowsforum.com/privacy)

## ✨ Features

- 🐞 **Real debugging.** Dumps are analyzed by a WinDBG server, not guessed at.
- 🤖 **AI reports.** Stop code, culprit driver, probable cause and step-by-step fixes, validated against a strict schema.
- 🧠 **Learns from history.** Prompts include anonymous stats from 15,000+ past analyses, such as which drivers usually cause each stop code.
- 📦 **Many formats.** `.dmp`, `.mdmp`, `.hdmp`, `.kdmp`, plus `.zip`, `.7z` and `.rar` archives.
- 📊 **Public crash stats.** Top stop codes, drivers, Windows builds, heatmaps and trends at `/stats`.
- 🔌 **REST API.** Async upload-and-poll endpoint for your own tools.
- 🛡️ **Locked down.** CSP + SRI, Cloudflare Turnstile, signed sessions, rate limits, prompt and response validation.

## 🔄 How it works

```
Browser ──▶ Fastify on Cloud Run ──▶ WinDBG server ──▶ AI model ──▶ your report
                 │
                 ├─▶ BigQuery corpus (private): analyses + AI reports, used to improve the AI
                 └─◀ Cloud Storage JSON: /stats data + AI priors (built by scheduled BigQuery queries)
```

If the WinDBG server is unavailable, the analyzer falls back to local analysis of the dump. Cloud Run never queries BigQuery directly: scheduled queries publish small JSON files, which keeps costs in the free tier.

## 🚀 Quick start

Needs Node.js `^22.19.0 || >=24.6.0` and npm 11.

```bash
git clone https://github.com/faratech/bsod-analyzer.git
cd bsod-analyzer
npm install
echo "DEEPSEEK_API_KEY=your-key" > .env.local   # key for the model in model.cfg
npm run dev                                   # backend :8080 + Vite frontend
```

| Command | What it does |
|---|---|
| `npm run dev` | 🧪 Backend + frontend with hot reload |
| `npm test` | ✅ Node test suite |
| `npm run typecheck` | 🔍 TypeScript check |
| `npm run build` | 🏗️ Production build + SRI hashes + prerendered pages |
| `npm run check` | 🚦 Everything CI runs (test + typecheck + build) |
| `npm start` | ▶️ Production server |

## ⚙️ Configuration

`model.cfg` picks the AI model (currently `deepseek-v4-flash`); the browser can never choose one. Key environment variables:

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` | Key for the selected model |
| `EXPLABS_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Optional free-tier and failover AI routes |
| `WINDBG_API_KEY`, `WINDBG_API_BASE_URL` | WinDBG server access (without it, local fallback only) |
| `SESSION_SECRET`, `TURNSTILE_SECRET_KEY` | Sessions and bot protection (production) |
| `BSOD_API_KEY` | Enables the external REST API |
| `STATS_BUCKET` | Cloud Storage bucket with the published stats JSON |
| `CORPUS_ENABLED`, `CORPUS_PRIORS_ENABLED` | Corpus recording and AI priors (both on by default) |
| `MAINTENANCE_MODE` | `true` serves a friendly 503 page |

## 🔌 API

```bash
# Submit a dump (returns 202 with a job uid)
curl -H "x-api-key: $BSOD_API_KEY" -F "file=@MEMORY.DMP" https://bsod.windowsforum.com/api/analyze

# Poll until status is "completed" (or "failed")
curl -H "x-api-key: $BSOD_API_KEY" https://bsod.windowsforum.com/api/analyze/status/<uid>
```

A completed job returns the AI report in `data`. API use is covered by the [privacy & data-use notice](https://bsod.windowsforum.com/privacy).

## 🔒 Privacy

Analyzing a dump requires keeping **"Use my crash analysis to improve BSOD AI"** checked. We keep analyses to improve the AI and publish only anonymous, aggregate statistics; we never publish dumps or their contents. Details are at [/privacy](https://bsod.windowsforum.com/privacy).

## ☁️ Deployment

Merging to `main` deploys automatically: Cloud Build builds the image and ships it to Cloud Run (`us-east1`). Secrets live in Google Secret Manager; `deploy-with-secret.sh` is the manual path. Uptime and upload-failure alerts run in Cloud Monitoring.

📚 More detail: [`CLAUDE.md`](CLAUDE.md) (architecture and operations), [`bigquery/`](bigquery/) (stats pipeline SQL), [`docs/SECRET-MANAGEMENT.md`](docs/SECRET-MANAGEMENT.md).

## 🤝 Contributing

PRs are welcome! Branch off `main`, run `npm run check`, and open a pull request. Issues go to the [GitHub tracker](https://github.com/faratech/bsod-analyzer/issues).

## 📄 License

[CC BY 4.0](LICENSE). Share and adapt freely, with attribution:

```
BSOD Analyzer by the BSOD Analyzer Contributors, licensed under CC BY 4.0
Source: https://github.com/faratech/bsod-analyzer
```

## 🙏 Thanks

WinDBG analysis by [Stack-Tech](https://www.stack-tech.com) · Built with React, TypeScript, Vite and Fastify · Hosted on Google Cloud Run
