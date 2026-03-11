#!/bin/bash
# ── Full Deploy: Director + Rust Engine + Frontend ────────────────────────────
# Usage: ./deploy/deploy-all.sh [director|rust|frontend|all]
# Default: all
# Requires: deploy/.env.deploy (copy from .env.deploy.example and fill in)
# ─────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"

# Load deploy config (for summary output)
DEPLOY_ENV="${SCRIPT_DIR}/.env.deploy"
if [ ! -f "$DEPLOY_ENV" ]; then
  echo "ERROR: Missing ${DEPLOY_ENV}"
  echo "Copy deploy/.env.deploy.example to deploy/.env.deploy and fill in values."
  exit 1
fi
source "$DEPLOY_ENV"

# Generate SSH key once if missing
if [ ! -f /tmp/starship-temp-key ]; then
  echo "Generating temp SSH key..."
  ssh-keygen -t rsa -b 2048 -f /tmp/starship-temp-key -N "" -q
fi

case "$TARGET" in
  director)
    bash "$SCRIPT_DIR/deploy-director.sh"
    ;;
  rust)
    bash "$SCRIPT_DIR/deploy-rust.sh"
    ;;
  frontend)
    bash "$SCRIPT_DIR/deploy-frontend.sh"
    ;;
  all)
    echo ">>> Deploying all services in parallel..."
    bash "$SCRIPT_DIR/deploy-rust.sh" &
    RUST_PID=$!
    bash "$SCRIPT_DIR/deploy-director.sh" &
    DIR_PID=$!
    wait $RUST_PID && echo "Rust Engine: DONE"
    wait $DIR_PID  && echo "Director:    DONE"
    bash "$SCRIPT_DIR/deploy-frontend.sh"
    echo ""
    echo "========================================="
    echo "All services deployed!"
    echo "  Frontend: https://${CLOUDFRONT_DOMAIN}"
    echo "  Director: ${DIRECTOR_IP} (via CF)"
    echo "  Rust Eng: ${RUST_IP} (via CF)"
    echo "========================================="
    ;;
  *)
    echo "Usage: $0 [director|rust|frontend|all]"
    exit 1
    ;;
esac
