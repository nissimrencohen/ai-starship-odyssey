#!/bin/bash
# ── Full Deploy: Director + Rust Engine + Frontend ────────────────────────────
# Usage: ./deploy/deploy-all.sh [director|rust|frontend|all]
# Default: all
# ─────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(dirname "$0")"
TARGET="${1:-all}"

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
    echo "  Frontend: https://d3cuox6dfl2gvk.cloudfront.net"
    echo "  Director: 18.232.168.75 (via CF)"
    echo "  Rust Eng: 23.22.74.240 (via CF)"
    echo "========================================="
    ;;
  *)
    echo "Usage: $0 [director|rust|frontend|all]"
    exit 1
    ;;
esac
