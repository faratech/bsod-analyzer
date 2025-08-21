#!/bin/bash

# Script to verify no secrets are present in the repository
# Run this before making the repository public

set -e

echo "🔍 Verifying repository for secrets..."
echo ""

FOUND_ISSUES=0

# Check for common secret patterns
echo "Checking for potential secrets in files..."

# Patterns to search for
PATTERNS=(
    "AIza[0-9A-Za-z-_]{35}"  # Google API key
    "0x4AAAAAAA[A-Za-z0-9_-]{32}"  # Turnstile secret pattern
    "sk-[A-Za-z0-9]{32}"  # OpenAI API key
    "ghp_[A-Za-z0-9]{36}"  # GitHub personal access token
    "ghs_[A-Za-z0-9]{36}"  # GitHub secret
    "password\s*=\s*[\"'][^\"']+[\"']"  # Password assignments
    "secret\s*=\s*[\"'][^\"']+[\"']"  # Secret assignments
    "token\s*=\s*[\"'][^\"']+[\"']"  # Token assignments
)

for pattern in "${PATTERNS[@]}"; do
    echo -n "  Checking for pattern: ${pattern:0:20}... "
    if grep -r -E "$pattern" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude="*.lock" --exclude="verify-no-secrets.sh" . 2>/dev/null; then
        echo "❌ FOUND!"
        FOUND_ISSUES=$((FOUND_ISSUES + 1))
    else
        echo "✅ Clean"
    fi
done

# Check for specific known secrets that were removed
echo ""
echo "Checking for specific removed secrets..."

REMOVED_SECRETS=(
    "0x4AAAAAAABiq4xGK4Dbs8cfnWQiDYt7_WQ"  # Old Turnstile secret
    "0x4AAAAAAABiq8SlsW8IhYCkxYJVu7Yj2gk"  # New Turnstile secret
)

for secret in "${REMOVED_SECRETS[@]}"; do
    echo -n "  Checking for: ${secret:0:20}... "
    if grep -r -F "$secret" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude="*.lock" --exclude="verify-no-secrets.sh" . 2>/dev/null; then
        echo "❌ FOUND! This secret must be removed!"
        FOUND_ISSUES=$((FOUND_ISSUES + 1))
    else
        echo "✅ Not found (good)"
    fi
done

# Check for .env files
echo ""
echo "Checking for environment files..."
if [ -f ".env" ]; then
    echo "  ❌ .env file exists! Remove it before going public!"
    FOUND_ISSUES=$((FOUND_ISSUES + 1))
else
    echo "  ✅ No .env file found"
fi

# Check .gitignore
echo ""
echo "Checking .gitignore..."
if grep -q "^\.env$" .gitignore 2>/dev/null; then
    echo "  ✅ .env is in .gitignore"
else
    echo "  ⚠️  .env is not in .gitignore!"
fi

# Check for internal project references
echo ""
echo "Checking for internal project references..."
echo -n "  Checking for project-bigfoot... "
PROJECT_BIGFOOT_COUNT=$(grep -r "project-bigfoot" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude="*.lock" . 2>/dev/null | wc -l)
if [ "$PROJECT_BIGFOOT_COUNT" -gt 0 ]; then
    echo "Found in $PROJECT_BIGFOOT_COUNT files (review if this should be genericized)"
else
    echo "✅ Not found"
fi

# Summary
echo ""
echo "========================================="
if [ $FOUND_ISSUES -eq 0 ]; then
    echo "✅ VERIFICATION PASSED!"
    echo "No secrets or sensitive information found."
    echo "Repository appears safe to make public."
else
    echo "❌ VERIFICATION FAILED!"
    echo "Found $FOUND_ISSUES issue(s) that need to be addressed."
    echo "Fix these issues before making the repository public!"
fi
echo "========================================="

exit $FOUND_ISSUES