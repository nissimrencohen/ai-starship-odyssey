#!/bin/bash
# ── Deploy React Frontend to S3 + CloudFront ──────────────────────────────────
# Usage: ./deploy/deploy-frontend.sh
# All WS/HTTP connections route through CloudFront (single HTTPS domain).
# ─────────────────────────────────────────────────────────────────────────────

set -e

CLOUDFRONT_DOMAIN="d3cuox6dfl2gvk.cloudfront.net"
CLOUDFRONT_ID="E1NRIS4HZUY13Y"
S3_BUCKET="starship-frontend-131677314808"

echo "=== [1/2] Building React with CloudFront URLs ==="
cd "$(dirname "$0")/../apps/web-client"

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
