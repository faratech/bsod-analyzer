# Secret Management for BSOD Analyzer

This document describes how secrets are managed for the BSOD Analyzer application using Google Secret Manager.

## Overview

All sensitive configuration values are stored in Google Secret Manager and injected into the Cloud Run service at runtime. This ensures that secrets are never exposed in code or container images.

## Required Secrets

### 1. Gemini API Key (`gemini-api-key`)
- **Purpose**: Authentication for Google's Gemini AI API
- **Usage**: Required for AI-powered crash dump analysis
- **How to obtain**: https://makersuite.google.com/app/apikey

### 2. Turnstile Secret Key (`turnstile-secret-key`)
- **Purpose**: Server-side verification of Cloudflare Turnstile CAPTCHA
- **Usage**: Validates CAPTCHA tokens before allowing file uploads
- **Site Key** (public): Can be found in `components/FileUploader.tsx`
- **Secret Key**: Must be obtained from Cloudflare dashboard and stored securely
- **How to obtain**: https://dash.cloudflare.com/turnstile

### 3. Session Secret (`session-secret`)
- **Purpose**: Cryptographic secret for session token generation
- **Usage**: Used with xxhash to create secure session identifiers
- **Value**: Auto-generated 32-byte random hex string

## Setup Instructions

### Quick Setup (All Secrets)

```bash
# Run the comprehensive setup script
./setup-all-secrets.sh
```

This script will:
1. Prompt for your Gemini API key
2. Set up the Turnstile secret key
3. Generate a random session secret
4. Grant Cloud Run access to all secrets

### Individual Secret Setup

#### Turnstile Secret Only
```bash
./setup-turnstile-secret.sh
```

#### Manual Secret Creation
```bash
# Create a secret
echo -n "SECRET_VALUE" | gcloud secrets create SECRET_NAME \
    --replication-policy="automatic" \
    --data-file=- \
    --project=PROJECT_ID

# Grant Cloud Run access
gcloud secrets add-iam-policy-binding SECRET_NAME \
    --member="serviceAccount:SERVICE_ACCOUNT_EMAIL" \
    --role="roles/secretmanager.secretAccessor" \
    --project=PROJECT_ID
```

## Deployment Configuration

The `deploy-with-secret.sh` script automatically configures Cloud Run to use these secrets:

```bash
--update-secrets \
  GEMINI_API_KEY=gemini-api-key:latest,\
  TURNSTILE_SECRET_KEY=turnstile-secret-key:latest,\
  SESSION_SECRET=session-secret:latest
```

## Local Development

For local development, create a `.env.local` file:

```env
GEMINI_API_KEY=your-gemini-api-key-here
TURNSTILE_SECRET_KEY=your-turnstile-secret-key-here
SESSION_SECRET=any-random-string-for-dev
```

**Note**: Never commit `.env.local` to version control!

## Security Best Practices

1. **Rotation**: Regularly rotate secrets, especially the session secret
2. **Access Control**: Only grant secret access to required service accounts
3. **Monitoring**: Enable audit logging for secret access
4. **Environment Separation**: Use different secrets for dev/staging/production

## Verification Commands

```bash
# List all secrets
gcloud secrets list --project=PROJECT_ID

# View secret metadata (not the value)
gcloud secrets describe SECRET_NAME --project=PROJECT_ID

# Access secret value (be careful!)
gcloud secrets versions access latest --secret=SECRET_NAME --project=PROJECT_ID

# Check IAM bindings
gcloud secrets get-iam-policy SECRET_NAME --project=PROJECT_ID
```

## Troubleshooting

### Secret Not Found Error
- Ensure the secret exists: `gcloud secrets list`
- Check the exact secret name matches in deployment script
- Verify Cloud Run has access to the secret

### Permission Denied
- Check service account has `secretmanager.secretAccessor` role
- Ensure project ID is correct
- Verify you're using the right service account

### Environment Variable Not Set
- Check Cloud Run service configuration
- Ensure deployment script includes all `--update-secrets` entries
- Restart the service after updating secrets