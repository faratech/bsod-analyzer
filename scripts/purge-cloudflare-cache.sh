#!/bin/bash

# Purge Cloudflare cache for bsod.windowsforum.com
# Called automatically after Cloud Run deployment

set -e

HOSTNAME="bsod.windowsforum.com"

# Check for required environment variables
if [ -z "$CLOUDFLARE_PURGE_TOKEN" ]; then
    echo "⚠️  CLOUDFLARE_PURGE_TOKEN not set, skipping cache purge"
    exit 0
fi

if [ -z "$CLOUDFLARE_ZONE_ID" ]; then
    echo "⚠️  CLOUDFLARE_ZONE_ID not set, skipping cache purge"
    exit 0
fi

echo "🧹 Purging Cloudflare cache for ${HOSTNAME}..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_PURGE_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"hosts\":[\"${HOSTNAME}\"]}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    SUCCESS=$(echo "$BODY" | grep -o '"success":true' || true)
    if [ -n "$SUCCESS" ]; then
        echo "✅ Cloudflare cache purged successfully for ${HOSTNAME}"
    else
        echo "⚠️  Cloudflare returned 200 but success was not true"
        echo "$BODY"
    fi
else
    echo "❌ Failed to purge Cloudflare cache (HTTP ${HTTP_CODE})"
    echo "$BODY"
    exit 1
fi
