#!/bin/bash

# Setup all required secrets for BSOD Analyzer in Google Secret Manager

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-bigfoot"}

echo "🔐 Setting up all required secrets for BSOD Analyzer"
echo "Project: ${PROJECT_ID}"
echo ""

# Function to create or update a secret
setup_secret() {
    local SECRET_NAME=$1
    local SECRET_VALUE=$2
    local SECRET_DESC=$3
    
    echo "📌 Setting up ${SECRET_DESC}..."
    
    # Check if secret already exists
    if gcloud secrets describe ${SECRET_NAME} --project=${PROJECT_ID} >/dev/null 2>&1; then
        echo "  ⚠️  Secret '${SECRET_NAME}' already exists"
        echo -n "  Do you want to update it? (y/N): "
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            # Add a new version of the secret
            echo -n "${SECRET_VALUE}" | gcloud secrets versions add ${SECRET_NAME} \
                --data-file=- \
                --project=${PROJECT_ID}
            echo "  ✅ Secret updated"
        else
            echo "  ℹ️  Keeping existing secret"
        fi
    else
        # Create the secret
        echo -n "${SECRET_VALUE}" | gcloud secrets create ${SECRET_NAME} \
            --replication-policy="automatic" \
            --data-file=- \
            --project=${PROJECT_ID}
        echo "  ✅ Secret created"
    fi
}

# 1. Gemini API Key
echo "1️⃣ Gemini API Key"
echo -n "Enter your Gemini API Key (or press Enter to skip): "
read -r -s GEMINI_KEY
echo ""
if [ ! -z "$GEMINI_KEY" ]; then
    setup_secret "gemini-api-key" "$GEMINI_KEY" "Gemini API Key"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 2. Turnstile Secret Key
echo "2️⃣ Cloudflare Turnstile Secret Key"
TURNSTILE_KEY="0x4AAAAAAABiq4xGK4Dbs8cfnWQiDYt7_WQ"
setup_secret "turnstile-secret-key" "$TURNSTILE_KEY" "Turnstile Secret Key"
echo ""

# 3. Session Secret (optional - generate random if not exists)
echo "3️⃣ Session Secret Key"
if ! gcloud secrets describe session-secret --project=${PROJECT_ID} >/dev/null 2>&1; then
    SESSION_SECRET=$(openssl rand -hex 32)
    setup_secret "session-secret" "$SESSION_SECRET" "Session Secret"
else
    echo "  ℹ️  Session secret already exists"
fi
echo ""

# Grant Cloud Run service account access to all secrets
echo "🔓 Granting Cloud Run access to all secrets..."
SERVICE_ACCOUNT=$(gcloud iam service-accounts list \
    --filter="displayName:Compute Engine default service account" \
    --format="value(email)" \
    --project=${PROJECT_ID})

if [ -z "$SERVICE_ACCOUNT" ]; then
    PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format="value(projectNumber)")
    SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "Using service account: ${SERVICE_ACCOUNT}"

# Grant access to each secret
for SECRET in "gemini-api-key" "turnstile-secret-key" "session-secret"; do
    if gcloud secrets describe ${SECRET} --project=${PROJECT_ID} >/dev/null 2>&1; then
        gcloud secrets add-iam-policy-binding ${SECRET} \
            --member="serviceAccount:${SERVICE_ACCOUNT}" \
            --role="roles/secretmanager.secretAccessor" \
            --project=${PROJECT_ID} >/dev/null 2>&1
        echo "  ✅ Access granted for ${SECRET}"
    fi
done

echo ""
echo "✅ All secrets configured successfully!"
echo ""
echo "📝 Next Steps:"
echo "1. Update deploy-with-secret.sh if adding new secrets"
echo "2. Deploy your service with: ./deploy-with-secret.sh"
echo ""
echo "🔍 To list all secrets:"
echo "   gcloud secrets list --project=${PROJECT_ID}"
echo ""
echo "🔍 To view a specific secret:"
echo "   gcloud secrets versions access latest --secret=SECRET_NAME --project=${PROJECT_ID}"

# Make scripts executable
chmod +x setup-all-secrets.sh
chmod +x setup-turnstile-secret.sh
chmod +x deploy-with-secret.sh