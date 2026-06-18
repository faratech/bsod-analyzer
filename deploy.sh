#!/bin/bash

# BSOD Analyzer - Google Cloud Run Deployment Script
#
# The supported deployment path is deploy-with-secret.sh. It deploys with the
# dedicated runtime service account and Secret Manager bindings required by the
# production server. Keep this wrapper for backwards-compatible muscle memory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy-with-secret.sh"
