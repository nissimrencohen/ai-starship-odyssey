#!/bin/bash
# ── Deploy Rust Engine to EC2 ──────────────────────────────────────────────────
# Usage: ./deploy/deploy-rust.sh
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

ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/starship-rust"

echo "=== [1/4] Building Rust Engine Docker image ==="
docker build -t starship-rust "${SCRIPT_DIR}/../engines/core-state"

echo "=== [2/4] Pushing to ECR ==="
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker tag starship-rust:latest "${ECR_REPO}:latest"
docker push "${ECR_REPO}:latest"

echo "=== [3/4] Uploading SSH key via EC2 Instance Connect ==="
if [ ! -f /tmp/starship-temp-key ]; then
  ssh-keygen -t rsa -b 2048 -f /tmp/starship-temp-key -N "" -q
fi
PUB_KEY=$(cat /tmp/starship-temp-key.pub)
aws ec2-instance-connect send-ssh-public-key \
  --instance-id "$RUST_INSTANCE" \
  --instance-os-user ec2-user \
  --ssh-public-key "$PUB_KEY" \
  --region "$AWS_REGION" > /dev/null

echo "=== [4/4] Deploying on EC2 ==="
ssh -i /tmp/starship-temp-key \
  -o StrictHostKeyChecking=no \
  -o ConnectTimeout=15 \
  "ec2-user@${RUST_IP}" bash << REMOTE
set -e

sudo systemctl start docker 2>/dev/null || true

sudo aws ecr get-login-password --region ${AWS_REGION} | \
  sudo docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

sudo docker pull ${ECR_REPO}:latest

sudo docker stop rust-engine 2>/dev/null || true
sudo docker rm   rust-engine 2>/dev/null || true

sudo docker run -d \
  --name rust-engine \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 8081:8081 \
  -e PYTHON_DIRECTOR_URL=http://${DIRECTOR_IP}:8000 \
  ${ECR_REPO}:latest

# Nginx: port 80 → HTTP/WS proxy for CloudFront
if ! command -v nginx &>/dev/null; then
  sudo dnf install -y nginx
fi

sudo tee /etc/nginx/conf.d/rust-engine.conf > /dev/null << 'NGINX'
server {
    listen 80;
    location /ws {
        proxy_pass http://127.0.0.1:8081/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX

sudo systemctl enable nginx
sudo systemctl restart nginx

echo "Rust Engine deployed. Waiting for startup..."
sleep 5
sudo docker logs rust-engine --tail 5
REMOTE

echo ""
echo "=== Deploy complete ==="
echo "Rust Engine HTTP: http://${RUST_IP}:8080"
echo "Rust Engine WS:   ws://${RUST_IP}:8081/ws"
