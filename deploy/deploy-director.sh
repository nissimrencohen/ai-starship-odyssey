#!/bin/bash
# ── Deploy Python Director to EC2 ─────────────────────────────────────────────
# Usage: ./deploy/deploy-director.sh
# Requires: deploy/.env.deploy (copy from .env.deploy.example and fill in)
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

# Load API keys from root .env
ROOT_ENV="${SCRIPT_DIR}/../.env"
if [ -f "$ROOT_ENV" ]; then source "$ROOT_ENV"; fi

ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/starship-director"

echo "=== [1/4] Building Director Docker image ==="
docker build -t starship-director "${SCRIPT_DIR}/../apps/python-director"

echo "=== [2/4] Pushing to ECR ==="
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
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
  --region "$AWS_REGION" > /dev/null

echo "=== [4/4] Deploying on EC2 ==="
ssh -i /tmp/starship-temp-key \
  -o StrictHostKeyChecking=no \
  -o ConnectTimeout=15 \
  "ec2-user@${DIRECTOR_IP}" bash << REMOTE
set -e
sudo systemctl start docker 2>/dev/null || true
sudo aws ecr get-login-password --region ${AWS_REGION} | \
  sudo docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com 2>/dev/null
sudo docker pull ${ECR_REPO}:latest 2>&1 | tail -2
sudo docker stop python-director 2>/dev/null; sudo docker rm python-director 2>/dev/null

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
  -e AWS_REGION=${AWS_REGION} \
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

# Nginx: port 80 → 8000 (CloudFront http-only origin)
if ! command -v nginx &>/dev/null; then sudo dnf install -y nginx; fi
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
sudo systemctl enable nginx && sudo systemctl restart nginx
sleep 8
sudo docker logs python-director --tail 5
REMOTE

echo "=== Director deployed ==="
echo "  Direct:  http://${DIRECTOR_IP}:8000"
echo "  Via CF:  https://${CLOUDFRONT_DOMAIN}"
