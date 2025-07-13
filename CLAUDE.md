# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `npm install`
- **Start development server**: `npm run dev` (runs both backend and frontend concurrently)
- **Start backend only**: `npm run dev:backend`
- **Start frontend only**: `npm run dev:frontend`
- **Build for production**: `npm run build`
- **Run production server**: `npm start`
- **Deploy to Cloud Run**: `./deploy-with-secret.sh` (uses Secret Manager for API key)

No test or lint commands are configured in this project.

## Environment Setup

- Create `.env.local` file with `GEMINI_API_KEY=your-api-key` for local development
- For production, API key is stored in Google Secret Manager as `gemini-api-key`
- The backend server runs on port 8080 by default

## Architecture Overview

This is a full-stack BSOD (Blue Screen of Death) analyzer that uses Google's Gemini AI. The application now features a secure backend proxy to protect the API key.

### Core Architecture

- **Frontend**: React app served by Express, makes API calls to `/api/gemini/generateContent`
- **Backend**: Node.js Express server (`server.js`) that proxies Gemini API calls
- **services/geminiProxy.ts**: Frontend service that mimics the original geminiService.ts but routes through backend
- **API Security**: Gemini API key is only accessible server-side, never exposed to client

### Key Workflows

1. **File Processing**: Supports .dmp files and .zip archives containing dump files. Uses JSZip for archive extraction
2. **Binary Analysis**: Extracts printable strings (ASCII and UTF-16LE) and hex dumps from binary dump files
3. **AI Analysis**: 
   - Frontend sends analysis request to `/api/gemini/generateContent`
   - Backend transforms field names (e.g., `responseMimeType` → `response_mime_type`)
   - Backend calls Gemini API (grounding disabled for JSON responses due to API limitation)
   - Grounding is enabled for advanced analysis tools that use text responses
   - Results returned with structured JSON schema
4. **Advanced Analysis**: Provides WinDbg-style debugging commands (!analyze -v, lm kv, !process 0 0, !vm)

### Data Flow

1. User uploads .dmp or .zip files via FileUploader component
2. Files are categorized as 'minidump' or 'kernel' based on 5MB threshold
3. Binary data is extracted client-side using `extractPrintableStrings()` and `generateHexDump()`
4. Frontend sends analysis request to backend proxy endpoint
5. Backend authenticates with Gemini API and forwards the request
6. Results are displayed in AnalysisReportCard components with expandable advanced analysis

### Deployment Architecture

- **Container**: Multi-stage Docker build with Node.js Alpine
- **Cloud Run**: Deployed with automatic scaling (0-10 instances)
- **Secret Management**: Uses Google Secret Manager for production API keys
- **Artifact Registry**: Docker images stored in `us-east1-docker.pkg.dev`

### Technology Stack

- **Frontend**: React 19, TypeScript, Vite
- **Backend**: Express.js, ES modules (`type: "module"`)
- **AI Service**: Google Gemini 2.5 Flash model with grounding via @google/generative-ai SDK
- **Styling**: CSS with custom properties and animations
- **File Processing**: FileReader API, JSZip for archive handling
- **Markdown**: react-markdown with remark-gfm for report rendering

### Security Considerations

- API key is never exposed to client code
- All Gemini API calls go through the backend proxy
- Production uses Google Secret Manager for key storage
- Files are processed client-side before being sent to the API (no file uploads to server)

### Monetization

- **Google AdSense**: Integrated with publisher ID ca-pub-7455498979488414
- **Ad Placements**: Strategic placements in Documentation and Home pages
- **Ad Components**: Reusable AdSense component with pre-configured slots
- **User Experience**: Ads are clearly labeled and styled to match the site theme