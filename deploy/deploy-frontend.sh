#!/bin/bash
# ── Deploy React Frontend to S3 + CloudFront ──────────────────────────────────
# Usage: ./deploy/deploy-frontend.sh
# Requires: deploy/.env.deploy (copy from .env.deploy.example and fill in)
# All WS/HTTP connections route through CloudFront (single HTTPS domain).
# ─────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load deploy config
DEPLOY_ENV="${SCRIPT_DIR}/.env.deploy"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "ERROR: Missing ${DEPLOY_ENV}"
  echo "Copy deploy/.env.deploy.example to deploy/.env.deploy and fill in values."
  exit 1
fi
source "$DEPLOY_ENV"

echo "=== [1/2] Building React with CloudFront URLs ==="
cd "${SCRIPT_DIR}/../apps/web-client"

VITE_DIRECTOR_URL="https://${CLOUDFRONT_DOMAIN}" \
VITE_ENGINE_WS_URL="wss://${CLOUDFRONT_DOMAIN}/ws" \
VITE_ENGINE_HTTP_URL="https://${CLOUDFRONT_DOMAIN}" \
npx vite build

echo "=== [2/2] Syncing to S3 + invalidating CloudFront ==="
cd dist

aws s3 sync . "s3://${S3_BUCKET}/" --delete \
  --cache-control "public, max-age=31536000"

# index.html: no-cache so users always get the latest version
aws s3 cp index.html "s3://${S3_BUCKET}/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"

aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text

echo ""
echo "=== Deploy complete ==="
echo "Frontend: https://${CLOUDFRONT_DOMAIN}"
