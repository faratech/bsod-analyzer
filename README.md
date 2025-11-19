# BSOD AI Analyzer

Enterprise-grade Windows crash dump analyzer powered by Google's Gemini AI. Instantly diagnose Blue/Black Screen of Death errors with advanced machine learning technology. Supports both classic blue screens and Windows 11's modern black screens.

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

## Security & Secret Management

### How Secrets Work

This application uses a **zero-trust security model** where no secrets are stored in the codebase:

#### Production Environment (Cloud Run)
- **All secrets are stored in Google Secret Manager**
- Cloud Run automatically injects secrets as environment variables
- No `.env` file exists or is needed in production
- The application reads secrets via `process.env` variables:
  - `GEMINI_API_KEY` - For Gemini AI API access
  - `TURNSTILE_SECRET_KEY` - For Cloudflare Turnstile verification
  - `SESSION_SECRET` - For secure session management

#### Local Development
For local development, you need to set environment variables:

1. **Using environment variables directly**:
   ```bash
   export GEMINI_API_KEY="your-key-here"
   export TURNSTILE_SECRET_KEY="your-secret-here"
   export SESSION_SECRET="any-random-string"
   npm run dev
   ```

2. **Using `.env` file** (optional, for convenience):
   ```bash
   # Copy the example and add your keys
   cp .env.example .env
   # Edit .env with your actual values
   npm run dev
   ```
   Note: The `.env` file is gitignored and should never be committed.

#### Secret Management Scripts
- `setup-all-secrets.sh` - Initial setup of all secrets in Google Secret Manager
- `update-turnstile-secret.sh` - Update Turnstile secret when regenerating keys
- `deploy-with-secret.sh` - Deploy to Cloud Run with secrets from Secret Manager

### Security Best Practices

1. **Never commit secrets**: The `.env` file is gitignored
2. **Rotate secrets regularly**: Use the update scripts to rotate secrets
3. **Use Secret Manager in production**: All Cloud Run deployments use Google Secret Manager
4. **Principle of least privilege**: Secrets are only accessible to the running service

### Required Secrets

| Secret | Purpose | How to Obtain |
|--------|---------|---------------|
| `GEMINI_API_KEY` | AI analysis via Google Gemini | [Google AI Studio](https://aistudio.google.com/) |
| `TURNSTILE_SECRET_KEY` | CAPTCHA verification | [Cloudflare Dashboard](https://dash.cloudflare.com/turnstile) |
| `SESSION_SECRET` | Session security | Auto-generated or any random string |

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
- **AI Service**: Google Gemini 3 Pro with grounding via @google/generative-ai SDK
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
  "model": "gemini-3-pro",
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

## Support

For issues and feature requests, please use the [GitHub issue tracker](https://github.com/faratech/bsod-analyzer/issues).

## License

This project is licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

### You are free to:
- **Share** — copy and redistribute the material in any medium or format
- **Adapt** — remix, transform, and build upon the material for any purpose, even commercially

### Under the following terms:
- **Attribution** — You must give appropriate credit, provide a link to the license, and indicate if changes were made

### How to Attribute:
When using this software, please include:
```
BSOD Analyzer by the BSOD Analyzer Contributors, licensed under CC BY 4.0
Source: https://github.com/faratech/bsod-analyzer
```

See the [LICENSE](LICENSE) file for full details.

## Contributing

Contributions are welcome! By contributing to this project, you agree to license your contributions under the same CC BY 4.0 license.

## Acknowledgments

- Powered by Google Gemini AI for intelligent crash analysis
- Built with React, TypeScript, and Vite
- Deployed on Google Cloud Run
