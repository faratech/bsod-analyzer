# API Key Security Setup

## Important: Never commit API keys to git!

### For Production (Google Cloud Run)
The API key is securely stored in Google Secret Manager:
- Secret name: `gemini-api-key`
- The deployment scripts automatically reference this secret

### For Local Development
1. Create a `.env.local` file in the project root
2. Add your API key: `GEMINI_API_KEY=your-key-here`
3. This file is gitignored and safe

### Security Architecture
- The API key is only used server-side in `server.js`
- Frontend uses a proxy at `/api/gemini/generateContent`
- No API keys are exposed to the client
- All API calls go through the backend proxy

### Before Committing
Always verify no API keys are exposed:
```bash
grep -r "AIza" . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```