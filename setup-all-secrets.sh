#!/bin/bash

# Setup all required secrets for BSOD Analyzer in Google Secret Manager

set -e

# Configuration
PROJECT_ID=${PROJECT_ID:-"project-bigfoot"}
RUNTIME_SERVICE_ACCOUNT_NAME=${RUNTIME_SERVICE_ACCOUNT_NAME:-"bsod-analyzer-runtime"}
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "🔐 Setting up all required secrets for BSOD Analyzer"
echo "Project: ${PROJECT_ID}"
echo "Runtime service account: ${RUNTIME_SERVICE_ACCOUNT}"
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
if [ -z "$TURNSTILE_SECRET_KEY" ]; then
    echo -n "Enter your Cloudflare Turnstile Secret Key (or press Enter to skip): "
    read -r -s TURNSTILE_KEY
    echo ""
else
    TURNSTILE_KEY="$TURNSTILE_SECRET_KEY"
    echo "  Using provided Turnstile secret from environment"
fi
if [ ! -z "$TURNSTILE_KEY" ]; then
    setup_secret "turnstile-secret-key" "$TURNSTILE_KEY" "Turnstile Secret Key"
else
    echo "  ⏭️  Skipped"
fi
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

# 4. External BSOD API Key
echo "4️⃣ External BSOD API Key"
if [ -z "$BSOD_API_KEY" ]; then
    echo -n "Enter your external BSOD API Key (or press Enter to skip): "
    read -r -s BSOD_KEY
    echo ""
else
    BSOD_KEY="$BSOD_API_KEY"
    echo "  Using provided BSOD API key from environment"
fi
if [ ! -z "$BSOD_KEY" ]; then
    setup_secret "bsod-api-key" "$BSOD_KEY" "External BSOD API Key"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 5. WinDBG API Key
echo "5️⃣ WinDBG API Key"
if [ -z "$WINDBG_API_KEY" ]; then
    echo -n "Enter your WinDBG API Key (or press Enter to skip): "
    read -r -s WINDBG_KEY
    echo ""
else
    WINDBG_KEY="$WINDBG_API_KEY"
    echo "  Using provided WinDBG API key from environment"
fi
if [ ! -z "$WINDBG_KEY" ]; then
    setup_secret "windbg-api-key" "$WINDBG_KEY" "WinDBG API Key"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 6. Upstash Redis URL
echo "6️⃣ Upstash Redis REST URL"
echo -n "Enter your Upstash Redis REST URL (or press Enter to skip): "
read -r UPSTASH_URL
echo ""
if [ ! -z "$UPSTASH_URL" ]; then
    setup_secret "upstash-redis-url" "$UPSTASH_URL" "Upstash Redis REST URL"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 7. Upstash Redis Token
echo "7️⃣ Upstash Redis REST Token"
echo -n "Enter your Upstash Redis REST Token (or press Enter to skip): "
read -r -s UPSTASH_TOKEN
echo ""
if [ ! -z "$UPSTASH_TOKEN" ]; then
    setup_secret "upstash-redis-token" "$UPSTASH_TOKEN" "Upstash Redis REST Token"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 8. Cloudflare Purge Token
echo "8️⃣ Cloudflare Purge Token"
echo -n "Enter your Cloudflare Purge Token (or press Enter to skip): "
read -r -s CF_PURGE_TOKEN
echo ""
if [ ! -z "$CF_PURGE_TOKEN" ]; then
    setup_secret "cloudflare-purge-token" "$CF_PURGE_TOKEN" "Cloudflare Purge Token"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# 9. Cloudflare Zone ID
echo "9️⃣ Cloudflare Zone ID"
echo -n "Enter your Cloudflare Zone ID (or press Enter to skip): "
read -r CF_ZONE_ID
echo ""
if [ ! -z "$CF_ZONE_ID" ]; then
    setup_secret "cloudflare-zone-id" "$CF_ZONE_ID" "Cloudflare Zone ID"
else
    echo "  ⏭️  Skipped"
fi
echo ""

# Create dedicated runtime service account
echo "🔐 Ensuring dedicated Cloud Run runtime service account exists..."
if ! gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" --project=${PROJECT_ID} >/dev/null 2>&1; then
    gcloud iam service-accounts create "${RUNTIME_SERVICE_ACCOUNT_NAME}" \
        --display-name="BSOD Analyzer Runtime" \
        --project=${PROJECT_ID} >/dev/null
    echo "  ✅ Created ${RUNTIME_SERVICE_ACCOUNT}"
else
    echo "  ℹ️  ${RUNTIME_SERVICE_ACCOUNT} already exists"
fi

echo "🔓 Granting runtime access only to application runtime secrets..."

# Grant access to each runtime secret. Cloudflare purge secrets are intentionally
# not granted to the runtime service account.
for SECRET in "gemini-api-key" "turnstile-secret-key" "session-secret" "bsod-api-key" "windbg-api-key" "upstash-redis-url" "upstash-redis-token"; do
    if gcloud secrets describe ${SECRET} --project=${PROJECT_ID} >/dev/null 2>&1; then
        gcloud secrets add-iam-policy-binding ${SECRET} \
            --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
            --role="roles/secretmanager.secretAccessor" \
            --project=${PROJECT_ID} >/dev/null 2>&1
        echo "  ✅ Access granted for ${SECRET}"
    fi
done

# Grant Cloud Build service account access to Cloudflare secrets
# (needed for cloudbuild.yaml secretEnv in the cache purge step)
echo "🔓 Granting Cloud Build access to Cloudflare secrets..."
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format="value(projectNumber)" 2>/dev/null || echo "")
if [ -n "$PROJECT_NUMBER" ]; then
    CLOUDBUILD_SERVICE_ACCOUNTS=(
        "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
        "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
    )
    if [ -n "${CLOUDBUILD_SERVICE_ACCOUNT:-}" ]; then
        CLOUDBUILD_SERVICE_ACCOUNTS+=("${CLOUDBUILD_SERVICE_ACCOUNT}")
    fi

    for CLOUDBUILD_SA in "${CLOUDBUILD_SERVICE_ACCOUNTS[@]}"; do
        MEMBER="serviceAccount:${CLOUDBUILD_SA}"
        if gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SERVICE_ACCOUNT}" \
            --member="${MEMBER}" \
            --role="roles/iam.serviceAccountUser" \
            --project=${PROJECT_ID} >/dev/null 2>&1; then
            echo "  ✅ ${CLOUDBUILD_SA} can deploy as ${RUNTIME_SERVICE_ACCOUNT}"
        else
            echo "  ⚠️  Could not grant deploy-as access to ${CLOUDBUILD_SA}"
        fi

        for SECRET in "cloudflare-purge-token" "cloudflare-zone-id"; do
            if gcloud secrets describe ${SECRET} --project=${PROJECT_ID} >/dev/null 2>&1; then
                if gcloud secrets add-iam-policy-binding ${SECRET} \
                    --member="${MEMBER}" \
                    --role="roles/secretmanager.secretAccessor" \
                    --project=${PROJECT_ID} >/dev/null 2>&1; then
                    echo "  ✅ Access granted for ${SECRET} to ${CLOUDBUILD_SA}"
                else
                    echo "  ⚠️  Could not grant ${SECRET} access to ${CLOUDBUILD_SA}"
                fi
            fi
        done
    done
else
    echo "  ⚠️  Could not determine project number, skipping Cloud Build SA grants"
fi

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
