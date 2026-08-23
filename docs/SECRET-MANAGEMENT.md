# Secret Management for BSOD Analyzer

This document describes how secrets are managed for the BSOD Analyzer application using Google Secret Manager.

## Overview

All sensitive configuration values are stored in Google Secret Manager and injected into the Cloud Run service at runtime. String values are exposed as environment variables; the Redis zstd dictionary is mounted as a binary file. This ensures that secrets are never exposed in code or container images.

## Runtime Secrets

### 1. Gemini API Key (`gemini-api-key`)
- **Purpose**: Authentication for Google's Gemini AI API
- **Usage**: Required when `model.cfg` selects a Gemini model
- **How to obtain**: https://makersuite.google.com/app/apikey

### 1b. DeepSeek API Key (`deepseek-api-key`)
- **Purpose**: Authentication for the DeepSeek API
- **Usage**: Required only when `model.cfg` is `deepseek-v4-flash`
- **How to obtain**: https://platform.deepseek.com/api_keys

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

### 4. External BSOD API Key (`bsod-api-key`)
- **Purpose**: Authenticates programmatic access to `POST /api/analyze`
- **Usage**: Injected as `BSOD_API_KEY`; if unset, the external API is disabled

### 5. WinDBG API Key (`windbg-api-key`)
- **Purpose**: Authenticates proxy requests to the remote WinDBG analysis service
- **Usage**: Injected as `WINDBG_API_KEY`; browser analysis can fall back to AI/local evidence if unavailable, but the external API server-side pipeline requires WinDBG

### 6. Upstash Redis REST URL (`upstash-redis-url`)
- **Purpose**: Upstash Redis REST endpoint for content cache and runtime state
- **Usage**: Injected as `UPSTASH_REDIS_REST_URL`

### 7. Upstash Redis REST Token (`upstash-redis-token`)
- **Purpose**: Upstash Redis REST authentication token
- **Usage**: Injected as `UPSTASH_REDIS_REST_TOKEN`
- **Note**: Production requires Redis-backed runtime state by default. Set `REQUIRE_REDIS_RUNTIME=false` only for controlled local/single-instance testing.

### 8. Redis zstd Dictionary (`redis-zstd-dictionary`)
- **Purpose**: Compresses `analysis:*` cache values using a dictionary trained from recent production analysis data
- **Usage**: Mounted read-only at `/secrets/redis-zstd/dictionary`; its Secret Manager version must always be a numeric version, never `latest`
- **Handling**: This is a private binary artifact. Train and upload it with `scripts/cache-zstd-dictionary.mjs`; never paste it into setup scripts, log its contents, or commit it
- **Rollout**: Explicitly set `CACHE_ZSTD_WRITES_ENABLED=false` for the dictionary-aware reader stage; normal production deployments enable writes after verification

### 9. Cloudflare Purge Token (`cloudflare-purge-token`)
- **Purpose**: Purge Cloudflare cache for `bsod.windowsforum.com` after deployment
- **Usage**: Used by the Cloud Build purge step and `deploy-with-secret.sh` to clear all cached assets under the hostname when new code deploys
- **How to obtain**: Create an API token at https://dash.cloudflare.com/profile/api-tokens with "Zone - Cache Purge - Purge" permission
- **Note**: Accessed by the Cloud Build service account via `secretEnv`, not by the app at runtime

### 10. Cloudflare Zone ID (`cloudflare-zone-id`)
- **Purpose**: Identifies the Cloudflare zone for cache purging
- **Usage**: Used alongside the purge token to target the correct zone
- **How to obtain**: Found on the zone overview page at https://dash.cloudflare.com
- **Note**: Accessed by the Cloud Build service account via `secretEnv`, not by the app at runtime

## Setup Instructions

### Quick Setup (All Secrets)

```bash
# Run the comprehensive setup script
./setup-all-secrets.sh
```

This script will:
1. Prompt for your Gemini API key
2. Optionally prompt for a DeepSeek API key
3. Set up the Turnstile secret key
4. Generate a random session secret
5. Prompt for Upstash Redis credentials
6. Prompt for Cloudflare purge token and zone ID
7. Create the empty `redis-zstd-dictionary` secret container without embedding dictionary bytes
8. Create/verify the dedicated Cloud Run runtime service account
9. Grant the runtime service account access to application runtime secrets, including the dictionary
10. Grant Cloud Build service accounts access to deploy as the runtime account and read Cloudflare purge secrets

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
  DEEPSEEK_API_KEY=deepseek-api-key:latest,\
  TURNSTILE_SECRET_KEY=turnstile-secret-key:latest,\
  SESSION_SECRET=session-secret:latest,\
  BSOD_API_KEY=bsod-api-key:latest,\
  WINDBG_API_KEY=windbg-api-key:latest,\
  UPSTASH_REDIS_REST_URL=upstash-redis-url:latest,\
  UPSTASH_REDIS_REST_TOKEN=upstash-redis-token:latest,\
  /secrets/redis-zstd/dictionary=redis-zstd-dictionary:NUMERIC_VERSION
```

It also sets `CACHE_ZSTD_DICTIONARY_PATH=/secrets/redis-zstd/dictionary` and,
after the completed reader-first rollout, defaults `CACHE_ZSTD_WRITES_ENABLED`
to `true`. Explicitly override it to `false` when staging a new reader revision.
The manual deployment script rejects `latest`, disabled/missing versions, and
non-boolean write flags.

## Redis Cache Dictionary Rollout

The dictionary must be trained while the current production cache still
contains the recent uncompressed analysis corpus. The operator tool reads only
`analysis:*` entries; runtime keys are excluded. It selects the newest 125
usable entries by default, trains on 100, validates against 25 held-out entries,
and reports raw, dictionaryless-zstd, and dictionary-zstd byte sizes. Redis
storage uses raw binary zstd payloads rather than base64.

1. Provision the secret container and runtime IAM binding:

   ```bash
   ./setup-all-secrets.sh
   ```

2. Export `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, then run the
   read-only benchmark. It does not upload a secret or modify Redis:

   ```bash
   node scripts/cache-zstd-dictionary.mjs
   ```

3. After reviewing the holdout results, explicitly train and upload the binary
   dictionary. Record the numeric version printed by the command:

   ```bash
   node scripts/cache-zstd-dictionary.mjs --upload --project=PROJECT_ID
   ```

4. Deploy a dictionary-aware reader revision with compressed writes disabled:

   ```bash
   CACHE_ZSTD_DICTIONARY_VERSION=NUMERIC_VERSION \
   CACHE_ZSTD_WRITES_ENABLED=false \
     ./deploy-with-secret.sh
   ```

   For Cloud Build, use:

   ```bash
   gcloud builds submit --config cloudbuild.yaml \
     --substitutions=_CACHE_ZSTD_DICTIONARY_VERSION=NUMERIC_VERSION,_CACHE_ZSTD_WRITES_ENABLED=false
   ```

5. Verify the mounted dictionary loads successfully and legacy JSON cache hits
   still decode. After the old revision has drained, enable compressed writes in
   a second deployment:

   ```bash
   CACHE_ZSTD_DICTIONARY_VERSION=NUMERIC_VERSION \
   CACHE_ZSTD_WRITES_ENABLED=true \
     ./deploy-with-secret.sh
   ```

   Persist the numeric version and `CACHE_ZSTD_WRITES_ENABLED=true` in the
   Cloud Build trigger (or equivalent deployment configuration) after this
   stage. The checked-in production deployment defaults reflect the completed
   rollout; use an explicit `false` override for future reader-only staging.

6. Verify new `analysis:*` values round-trip and retain the seven-day TTL.
   `runtime:*` values and atomic counters must remain uncompressed.

### Whole Redis Flush Is User-Owned

No deployment or dictionary tool flushes Redis. Only the Redis account owner
should initiate the planned whole-database flush, and only after compressed
writes have been verified during a drained or quiet window. A whole-database
flush deletes more than cached analyses: it also clears active sessions, dump
ownership, in-flight jobs, quotas, rate-limit/token counters, and other runtime
state. Existing users will need new sessions, and in-flight work will be lost.
It also removes private historical-dictionary registry records; this is safe at
that point because the old analysis values are removed too and the active
dictionary remains mounted from Secret Manager. Do not add the flush to an
automated deploy hook.

### Dictionary Rotation

Run the benchmark and explicit upload again, then deploy the newly printed
numeric version. Each dictionary-aware revision registers a SHA-256-addressed
copy under private Redis cache metadata so later revisions can decode entries
written with the prior dictionary. Keep those registry records and prior Secret
Manager versions available for at least the seven-day analysis TTL. Roll back
only to a dictionary-aware revision; a pre-feature revision cannot decode
values written in the compressed format.

### Cloud Build Cache Purge

After deployment, Cloud Build automatically purges the Cloudflare cache for `bsod.windowsforum.com`. The `cloudflare-purge-token` and `cloudflare-zone-id` secrets are injected via `secretEnv` in `cloudbuild.yaml`. These require IAM access for Cloud Build service accounts, including the legacy Cloud Build account (`PROJECT_NUMBER@cloudbuild.gserviceaccount.com`) and the Compute Engine default service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) when Cloud Build runs with that identity. `setup-all-secrets.sh` grants both, plus `CLOUDBUILD_SERVICE_ACCOUNT` if provided.

`deploy-with-secret.sh` also fetches Cloudflare purge secrets after a successful deploy. Missing purge credentials fail the deploy unless `SKIP_CF_PURGE=true` is set intentionally.

## Local Development

For local development, create a `.env.local` file:

```env
GEMINI_API_KEY=your-gemini-api-key-here
DEEPSEEK_API_KEY=your-deepseek-api-key-here
TURNSTILE_SECRET_KEY=your-turnstile-secret-key-here
SESSION_SECRET=any-random-string-for-dev
WINDBG_API_KEY=optional-windbg-key
UPSTASH_REDIS_REST_URL=optional-upstash-url
UPSTASH_REDIS_REST_TOKEN=optional-upstash-token
CACHE_ZSTD_DICTIONARY_PATH=optional-local-dictionary-path
CACHE_ZSTD_WRITES_ENABLED=false
```

**Note**: Never commit `.env.local` to version control!

Only the API key for the model selected in `model.cfg` is required. DeepSeek is
optional; `deploy-with-secret.sh` injects `DEEPSEEK_API_KEY` only when the
`deepseek-api-key` Secret Manager secret exists.

When running `NODE_ENV=production` locally without Redis, set
`REQUIRE_REDIS_RUNTIME=false`. When testing production mode outside Cloudflare,
also set `CLOUDFLARE_ONLY_INGRESS=false`.

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

# List version metadata without printing secret contents
gcloud secrets versions list SECRET_NAME --project=PROJECT_ID

# Check IAM bindings
gcloud secrets get-iam-policy SECRET_NAME --project=PROJECT_ID
```

Never send `redis-zstd-dictionary` bytes to standard output. The operator tool
uses a permission-restricted temporary file for the binary upload and removes it
on exit.

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
