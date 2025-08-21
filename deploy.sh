#!/bin/bash

# BSOD Analyzer - Google Cloud Run Deployment Script

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"your-project-id"}
REGION=${REGION:-"us-east1"}
SERVICE_NAME="bsod-analyzer"
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}"

echo "🚀 Deploying BSOD Analyzer to Google Cloud Run"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"

# Authenticate Docker with Artifact Registry
echo "🔐 Authenticating with Artifact Registry..."
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Build the Docker image
echo "🔨 Building Docker image..."
docker build -t ${IMAGE_NAME} .

# Push to Artifact Registry
echo "📤 Pushing image to Artifact Registry..."
docker push ${IMAGE_NAME}

# Deploy to Cloud Run
echo "☁️  Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME} \
  --platform managed \
  --region ${REGION} \
  --allow-unauthenticated \
  --port 8080 \
  --max-instances 10 \
  --min-instances 0 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars NODE_ENV=production

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --platform managed --region ${REGION} --format 'value(status.url)')

echo "✅ Deployment complete!"
echo "🌐 Service URL: ${SERVICE_URL}"
echo ""
echo "To update environment variables, run:"
echo "gcloud run services update ${SERVICE_NAME} --update-env-vars GEMINI_API_KEY=your-key-here --region ${REGION}"