#!/bin/bash

# Setup Cloudflare Turnstile Secret Key in Google Secret Manager

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-bigfoot"}
SECRET_NAME="turnstile-secret-key"

# Get the secret from environment variable or prompt
if [ -z "$TURNSTILE_SECRET_KEY" ]; then
    echo "Enter your Cloudflare Turnstile Secret Key:"
    read -s TURNSTILE_SECRET_KEY
    echo ""
fi

SECRET_VALUE="$TURNSTILE_SECRET_KEY"

echo "🔐 Setting up Cloudflare Turnstile Secret Key in Google Secret Manager"
echo "Project: ${PROJECT_ID}"
echo "Secret Name: ${SECRET_NAME}"

# Check if secret already exists
if gcloud secrets describe ${SECRET_NAME} --project=${PROJECT_ID} >/dev/null 2>&1; then
    echo "⚠️  Secret '${SECRET_NAME}' already exists"
    echo -n "Do you want to update it with a new version? (y/N): "
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        # Add a new version of the secret
        echo -n "${SECRET_VALUE}" | gcloud secrets versions add ${SECRET_NAME} \
            --data-file=- \
            --project=${PROJECT_ID}
        echo "✅ Secret updated with new version"
    else
        echo "ℹ️  Keeping existing secret"
    fi
else
    # Create the secret
    echo "Creating new secret..."
    echo -n "${SECRET_VALUE}" | gcloud secrets create ${SECRET_NAME} \
        --replication-policy="automatic" \
        --data-file=- \
        --project=${PROJECT_ID}
    echo "✅ Secret created successfully"
fi

# Grant Cloud Run service account access to the secret
echo "🔓 Granting Cloud Run access to the secret..."
SERVICE_ACCOUNT=$(gcloud iam service-accounts list \
    --filter="displayName:Compute Engine default service account" \
    --format="value(email)" \
    --project=${PROJECT_ID})

if [ -z "$SERVICE_ACCOUNT" ]; then
    # Try to get the default compute service account
    PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format="value(projectNumber)")
    SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "Using service account: ${SERVICE_ACCOUNT}"

gcloud secrets add-iam-policy-binding ${SECRET_NAME} \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=${PROJECT_ID} >/dev/null 2>&1

echo "✅ Access granted to Cloud Run service account"

# Display usage instructions
echo ""
echo "📝 Usage Instructions:"
echo "1. The secret is now stored in Google Secret Manager"
echo "2. Cloud Run will access it using the deployment configuration"
echo "3. Deploy your service with: ./deploy-with-secret.sh"
echo ""
echo "🔍 To verify the secret:"
echo "   gcloud secrets versions access latest --secret=${SECRET_NAME} --project=${PROJECT_ID}"
echo ""
echo "⚡ The deployment script is already configured to use this secret!"

# Make the script executable
chmod +x setup-turnstile-secret.sh