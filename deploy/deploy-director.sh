#!/bin/bash
# ── Deploy Python Director to EC2 ─────────────────────────────────────────────
# Usage: ./deploy/deploy-director.sh
# Requires: AWS CLI configured, Docker logged in to ECR, temp SSH key at /tmp/starship-temp-key
#
# What this script does:
#   1. Builds + pushes the Director Docker image to ECR
#   2. SSHs into the Director EC2 (via EC2 Instance Connect)
#   3. Pulls the new image, restarts the container with correct env vars
#   4. Ensures Nginx (port 80 reverse proxy) is running
# ─────────────────────────────────────────────────────────────────────────────

set -e

ACCOUNT_ID="131677314808"
REGION="us-east-1"
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/starship-director"
DIRECTOR_INSTANCE="i-09efcfe243030e561"
DIRECTOR_IP="18.232.168.75"
RUST_IP="23.22.74.240"
CLOUDFRONT_DOMAIN="d3cuox6dfl2gvk.cloudfront.net"
REDIS_URL="redis://starship-redis.vtgv11.0001.use1.cache.amazonaws.com:6379"
OPENSEARCH_URL="https://vpc-starship-knowledge-qsszian6yzsuobhwkaksol544y.us-east-1.es.amazonaws.com"

# Load API keys from .env
if [ -f "$(dirname "$0")/../.env" ]; then
  source "$(dirname "$0")/../.env"
fi

echo "=== [1/4] Building Director Docker image ==="
docker build -t starship-director ./apps/python-director

echo "=== [2/4] Pushing to ECR ==="
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
docker tag starship-director:latest "${ECR_REPO}:latest"
docker push "${ECR_REPO}:latest"

echo "=== [3/4] Uploading SSH key via EC2 Instance Connect ==="
if [ ! -f /tmp/starship-temp-key ]; then
  ssh-keygen -t rsa -b 2048 -f /tmp/starship-temp-key -N "" -q
fi
PUB_KEY=$(cat /tmp/starship-temp-key.pub)
aws ec2-instance-connect send-ssh-public-key \
  --instance-id "$DIRECTOR_INSTANCE" \
  --instance-os-user ec2-user \
  --ssh-public-key "$PUB_KEY" \
  --region "$REGION" > /dev/null

echo "=== [4/4] Deploying on EC2 ==="
ssh -i /tmp/starship-temp-key \
  -o StrictHostKeyChecking=no \
  -o ConnectTimeout=15 \
  ec2-user@"$DIRECTOR_IP" bash << REMOTE
set -e

# Ensure Docker is running
sudo systemctl start docker 2>/dev/null || true

# Authenticate ECR
sudo aws ecr get-login-password --region ${REGION} | \
  sudo docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com

# Pull latest image
sudo docker pull ${ECR_REPO}:latest

# Stop old container
sudo docker stop python-director 2>/dev/null || true
sudo docker rm   python-director 2>/dev/null || true

# Run with all env vars — SELF_URL must point to CloudFront (HTTPS)
sudo docker run -d \
  --name python-director \
  --restart unless-stopped \
  -p 8000:8000 \
  -e RUST_ENGINE_URL=http://${RUST_IP}:8080 \
  -e REDIS_URL=${REDIS_URL} \
  -e SELF_URL=https://${CLOUDFRONT_DOMAIN} \
  -e USE_AWS_RAG=true \
  -e DEMO_MODE=false \
  -e OPENSEARCH_ENDPOINT=${OPENSEARCH_URL} \
  -e AWS_REGION=${REGION} \
  -e AI_MODEL_MODE= \
  -e GOOGLE_API_KEY=${GOOGLE_API_KEY} \
  -e GROQ_API_KEY=${GROQ_API_KEY} \
  -e ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY} \
  -e GITHUB_API_KEY=${GITHUB_API_KEY} \
  -e HF_TOKEN=${HF_TOKEN} \
  -e COQUI_TOS_AGREED=1 \
  -e AUDIO_DIR=/app/audio \
  -e GENERATED_DIR=/app/generated \
  ${ECR_REPO}:latest

# Ensure Nginx is installed and running (port 80 → 8000 proxy for CloudFront)
if ! command -v nginx &>/dev/null; then
  sudo dnf install -y nginx
fi

sudo tee /etc/nginx/conf.d/director.conf > /dev/null << 'NGINX'
server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }
}
NGINX

sudo systemctl enable nginx
sudo systemctl restart nginx

echo "Director deployed. Waiting for startup..."
sleep 8
sudo docker logs python-director --tail 5
REMOTE

echo ""
echo "=== Deploy complete ==="
echo "Director: http://${DIRECTOR_IP}:8000  (via CF: https://${CLOUDFRONT_DOMAIN})"
