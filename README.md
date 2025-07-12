# BSOD AI Analyzer

Enterprise-grade Windows crash dump analyzer powered by Google's Gemini AI. Instantly diagnose Blue Screen of Death errors with advanced machine learning technology.

## Features

- 🔍 **Intelligent Analysis**: Leverages Google Gemini AI to analyze crash dumps
- 🌐 **Grounded Advanced Analysis**: Uses Google Search grounding in debugging tools for up-to-date information
- 📊 **Detailed Reports**: Provides probable causes, culprit drivers, and actionable recommendations
- 🛠️ **Advanced Debugging**: WinDbg-style commands (!analyze -v, lm kv, !process 0 0, !vm)
- 📦 **Multiple Formats**: Supports both .dmp files and .zip archives
- 🔒 **Secure Architecture**: API keys protected server-side with proxy implementation
- ⚡ **Real-time Processing**: Client-side binary analysis with server-side AI inference

## Quick Start

### Prerequisites

- Node.js 18+ 
- Google Cloud account (for deployment)
- Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/faratech/bsod-analyzer.git
   cd bsod-analyzer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment**
   ```bash
   # Create .env.local file
   echo "GEMINI_API_KEY=your-gemini-api-key" > .env.local
   ```

4. **Start development server**
   ```bash
   npm run dev
   ```
   This runs both the backend (port 8080) and frontend concurrently.

### Development Commands

- `npm run dev` - Start both backend and frontend servers
- `npm run dev:backend` - Start backend server only
- `npm run dev:frontend` - Start frontend dev server only
- `npm run build` - Build production frontend
- `npm start` - Run production server

## Architecture

### System Overview

The application uses a secure client-server architecture where sensitive API operations are proxied through a backend server:

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Browser   │────▶│   Express   │────▶│  Gemini API  │
│   (React)   │◀────│   Server    │◀────│   (Google)   │
└─────────────┘     └─────────────┘     └──────────────┘
     Frontend           Backend             AI Service
```

### Core Components

- **Frontend (`App.tsx`)**: React application handling file uploads and UI
- **Backend (`server.js`)**: Express server that proxies Gemini API calls
- **Proxy Service (`services/geminiProxy.ts`)**: Frontend service that routes API calls through backend
- **Binary Processing**: Client-side extraction of strings and hex dumps from crash dumps

### Data Flow

1. User uploads .dmp or .zip files via the web interface
2. Files are categorized as 'minidump' or 'kernel' (5MB threshold)
3. Binary data is processed client-side:
   - ASCII and UTF-16LE string extraction
   - Hex dump generation (first 1KB)
4. Processed data sent to backend proxy endpoint
5. Backend authenticates with Gemini API and forwards request
6. AI analysis results returned and displayed with interactive reports

### Security Architecture

- **API Key Protection**: Gemini API key stored server-side only
- **Proxy Pattern**: All AI requests routed through `/api/gemini/generateContent`
- **No File Storage**: Crash dumps processed in-memory, never stored
- **Secret Manager**: Production deployments use Google Secret Manager

## Deployment

### Quick Deploy to Google Cloud Run

```bash
# Set your project ID
export PROJECT_ID="your-gcp-project-id"

# Create API key secret
echo -n "your-gemini-api-key" | gcloud secrets create gemini-api-key --data-file=-

# Deploy using the provided script
./deploy-with-secret.sh
```

### Manual Deployment

1. **Build Docker image**
   ```bash
   docker build -t us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest .
   ```

2. **Push to Artifact Registry**
   ```bash
   docker push us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest
   ```

3. **Deploy to Cloud Run**
   ```bash
   gcloud run deploy bsod-analyzer \
     --image us-east1-docker.pkg.dev/$PROJECT_ID/bsod-analyzer/app:latest \
     --region us-east1 \
     --allow-unauthenticated \
     --update-secrets GEMINI_API_KEY=gemini-api-key:latest
   ```

### CI/CD with Cloud Build

The repository includes `cloudbuild.yaml` for automated deployments:

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

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite
- **Backend**: Express.js with ES modules
- **AI Service**: Google Gemini 2.5 Flash with grounding via @google/generative-ai SDK
- **Styling**: Custom CSS with animations
- **File Processing**: FileReader API, JSZip
- **Markdown**: react-markdown with GitHub Flavored Markdown
- **Deployment**: Docker, Google Cloud Run, Secret Manager

## API Reference

### POST /api/gemini/generateContent

Proxies requests to Google's Gemini API with automatic field name transformation.

**Request Body:**
```json
{
  "model": "gemini-2.5-flash",
  "contents": "...",
  "config": {
    "responseMimeType": "application/json",
    "responseSchema": {...},
    "temperature": 0.1
  },
  "tools": [{
    "googleSearch": {}
  }]
}
```

## Troubleshooting

### Common Issues

1. **API Key Errors**
   - Ensure `GEMINI_API_KEY` is set in `.env.local` for local development
   - For production, verify the secret exists: `gcloud secrets list`

2. **Container Start Failures**
   - Check logs: `gcloud logging read --limit 50`
   - Verify PORT environment variable is set to 8080

3. **Build Failures**
   - Ensure all dependencies are installed: `npm install`
   - Check Node.js version (requires 18+)

### Monitoring

View Cloud Run logs:
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=bsod-analyzer" --limit 50
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit changes: `git commit -am 'Add your feature'`
4. Push to branch: `git push origin feature/your-feature`
5. Submit a pull request

## License

This project is proprietary software. All rights reserved.

## Support

For issues and feature requests, please use the [GitHub issue tracker](https://github.com/faratech/bsod-analyzer/issues).
