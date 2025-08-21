#!/bin/bash

# Script to create a clean repository with no history
# This ensures no secrets are in the git history

set -e

echo "🔄 Creating a clean repository without history..."
echo ""
echo "⚠️  WARNING: This will create a new repository with no commit history!"
echo "Make sure you have a backup of your current repository."
echo ""
echo -n "Continue? (y/N): "
read -r response

if [[ ! "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Aborted."
    exit 1
fi

# Save current branch name
CURRENT_BRANCH=$(git branch --show-current)

# Save the remote URL
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

echo ""
echo "📁 Creating backup of .git directory..."
mv .git .git.backup.$(date +%Y%m%d_%H%M%S)

echo "🆕 Initializing new repository..."
git init

echo "📝 Configuring git..."
git config user.name "$(git config --global user.name 2>/dev/null || echo 'Your Name')"
git config user.email "$(git config --global user.email 2>/dev/null || echo 'your-email@example.com')"

echo "➕ Adding all files..."
git add .

echo "✅ Creating initial commit..."
git commit -m "Initial commit - BSOD Analyzer

Enterprise-grade Windows crash dump analyzer powered by Google's Gemini AI.

Features:
- Intelligent crash dump analysis using Gemini AI
- Support for minidump and kernel dump formats
- Secure architecture with no file storage
- Real-time processing with detailed reports
- WinDbg-style command outputs

Security:
- All secrets stored in Google Secret Manager
- No hardcoded credentials or API keys
- Production-ready security architecture

Tech Stack:
- Frontend: React 19, TypeScript, Vite
- Backend: Node.js 22+, Express 5
- AI: Google Gemini API
- Deployment: Google Cloud Run

Repository cleaned and prepared for open source release."

echo ""
echo "📊 Repository statistics:"
git log --oneline
echo ""
echo "Files in repository:"
git ls-files | wc -l
echo ""

if [ ! -z "$REMOTE_URL" ]; then
    echo "🔗 Original remote URL: $REMOTE_URL"
    echo ""
    echo "To add the remote back (for a NEW repository):"
    echo "  git remote add origin YOUR_NEW_REPO_URL"
    echo ""
    echo "To force push to the SAME repository (⚠️  This will DELETE all history):"
    echo "  git remote add origin $REMOTE_URL"
    echo "  git push --force origin main"
    echo ""
    echo "⚠️  WARNING: Force pushing will permanently delete all commit history!"
else
    echo "No remote was configured."
fi

echo ""
echo "✅ Clean repository created successfully!"
echo ""
echo "Next steps:"
echo "1. Create a new repository on GitHub (or use existing)"
echo "2. Add the remote: git remote add origin <your-repo-url>"
echo "3. Push the clean history: git push -u origin main"
echo ""
echo "Your old .git directory has been backed up with timestamp."