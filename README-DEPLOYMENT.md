# BSOD Analyzer - Cloud Run Deployment Guide

## Prerequisites

1. Google Cloud Project with billing enabled
2. Google Cloud SDK installed and configured
3. Docker installed locally
4. Gemini API key

## Quick Deployment

```bash
# Set your project ID
export PROJECT_ID="your-gcp-project-id"

# Enable required APIs
gcloud services enable run.googleapis.com containerregistry.googleapis.com cloudbuild.googleapis.com

# Configure Docker for GCR
gcloud auth configure-docker

# Run the deployment script
./deploy.sh
```

## Manual Deployment Steps

1. **Build the container:**
   ```bash
   docker build -t gcr.io/YOUR_PROJECT_ID/bsod-analyzer .
   ```

2. **Push to Container Registry:**
   ```bash
   docker push gcr.io/YOUR_PROJECT_ID/bsod-analyzer
   ```

3. **Deploy to Cloud Run:**
   ```bash
   gcloud run deploy bsod-analyzer \
     --image gcr.io/YOUR_PROJECT_ID/bsod-analyzer \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --port 8080
   ```

## Using Cloud Build (CI/CD)

The repository includes a `cloudbuild.yaml` for automated deployments:

```bash
# Submit a build
gcloud builds submit --config cloudbuild.yaml

# Set up trigger for automatic deployments on push
gcloud builds triggers create github \
  --repo-name=bsod-analyzer \
  --repo-owner=faratech \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

## Environment Variables

⚠️ **IMPORTANT**: The Gemini API key must be set for the application to function properly.

### Option 1: Direct Environment Variable (Quick Setup)
```bash
# Update the service with API key
gcloud run services update bsod-analyzer \
  --update-env-vars GEMINI_API_KEY=your-api-key-here \
  --region us-east1
```

### Option 2: Using Secret Manager (Recommended for Production)
See the Security Best Practices section below.

## Security Best Practices

1. **Never commit API keys** - Use Secret Manager instead:
   ```bash
   # Create a secret
   echo -n "your-api-key" | gcloud secrets create gemini-api-key --data-file=-
   
   # Grant Cloud Run access
   gcloud secrets add-iam-policy-binding gemini-api-key \
     --member=serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com \
     --role=roles/secretmanager.secretAccessor
   
   # Update Cloud Run to use the secret
   gcloud run services update bsod-analyzer \
     --update-secrets=GEMINI_API_KEY=gemini-api-key:latest
   ```

2. **Use Identity and Access Management (IAM)** to control who can deploy

3. **Enable Cloud Armor** for DDoS protection if needed

## Monitoring

View logs:
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=bsod-analyzer" --limit 50
```

View metrics in Cloud Console:
- CPU utilization
- Memory usage
- Request count
- Latency

## Cost Optimization

- The service is configured with `min-instances=0` for scale-to-zero
- Adjust memory and CPU based on actual usage
- Use Cloud CDN for static assets if traffic increases

## Troubleshooting

1. **Container fails to start:**
   - Check logs: `gcloud logging read`
   - Verify Dockerfile and nginx.conf

2. **API key issues:**
   - Ensure the key is properly set in environment variables
   - Check if the key has the necessary permissions

3. **High latency:**
   - Consider increasing CPU/memory allocation
   - Enable Cloud CDN for static assets