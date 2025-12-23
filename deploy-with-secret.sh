#!/bin/bash

# BSOD Analyzer - Cloud Run Deployment with Secret Manager

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-bigfoot"}
REGION=${REGION:-"us-east1"}
SERVICE_NAME=${SERVICE_NAME:-"bsod-analyzer"}

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
  --port 8080 \
  --max-instances 10 \
  --min-instances 0 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars NODE_ENV=production \
  --update-secrets GEMINI_API_KEY=gemini-api-key:latest,TURNSTILE_SECRET_KEY=turnstile-secret-key:latest,SESSION_SECRET=session-secret:latest,WINDBG_API_KEY=windbg-api-key:latest \
  --project ${PROJECT_ID}

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --format 'value(status.url)')

echo "✅ Deployment complete!"
echo "🌐 Service URL: ${SERVICE_URL}"