#!/bin/bash

# BSOD Analyzer - Cloud Run Deployment with Secret Manager

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-bigfoot"}
REGION=${REGION:-"us-east1"}
SERVICE_NAME=${SERVICE_NAME:-"bsod-analyzer"}
RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SERVICE_ACCOUNT:-"bsod-analyzer-runtime@${PROJECT_ID}.iam.gserviceaccount.com"}

echo "🚀 Deploying BSOD Analyzer to Google Cloud Run"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"

# Deploy directly from source
echo "☁️  Deploying to Cloud Run from source..."
gcloud run deploy ${SERVICE_NAME} \
  --source . \
  --platform managed \
  --region ${REGION} \
  --allow-unauthenticated \
  --no-default-url \
  --service-account ${RUNTIME_SERVICE_ACCOUNT} \
  --port 8080 \
  --concurrency 2 \
  --max-instances 10 \
  --min-instances 0 \
  --memory 1Gi \
  --cpu 1 \
  --set-env-vars NODE_ENV=production \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest,TURNSTILE_SECRET_KEY=turnstile-secret-key:latest,SESSION_SECRET=session-secret:latest,BSOD_API_KEY=bsod-api-key:latest,WINDBG_API_KEY=windbg-api-key:latest,UPSTASH_REDIS_REST_URL=upstash-redis-url:latest,UPSTASH_REDIS_REST_TOKEN=upstash-redis-token:latest \
  --project ${PROJECT_ID}

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --format 'value(status.url)')

echo "✅ Deployment complete!"
echo "🌐 Service URL: ${SERVICE_URL}"

# Purge Cloudflare cache
echo "🧹 Purging Cloudflare cache..."
if [ "${SKIP_CF_PURGE:-}" != "true" ]; then
  export CLOUDFLARE_PURGE_TOKEN=$(gcloud secrets versions access latest --secret=cloudflare-purge-token --project=${PROJECT_ID})
  export CLOUDFLARE_ZONE_ID=$(gcloud secrets versions access latest --secret=cloudflare-zone-id --project=${PROJECT_ID})
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/scripts/purge-cloudflare-cache.sh"
