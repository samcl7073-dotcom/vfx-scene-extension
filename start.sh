#!/usr/bin/env bash
#
# Launch both ComfyUI (sidecar) and the FastAPI backend.
# Usage:  ./start.sh
#
# ComfyUI runs headless on port 8188.
# FastAPI runs on port 8000 (with --reload for development).
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

COMFYUI_DIR="$SCRIPT_DIR/comfyui"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

COMFYUI_PORT=8188
BACKEND_PORT=8000

# ---------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[start]${NC} $*"; }
warn()  { echo -e "${YELLOW}[start]${NC} $*"; }

# ---------------------------------------------------------------
# Cleanup on exit — kill background jobs
# ---------------------------------------------------------------
cleanup() {
    info "Shutting down..."
    kill $(jobs -p) 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------
# 1. Start ComfyUI (headless)
# ---------------------------------------------------------------
info "Starting ComfyUI on port $COMFYUI_PORT..."
(
    cd "$COMFYUI_DIR"
    source .venv/bin/activate
    python main.py \
        --listen 127.0.0.1 \
        --port "$COMFYUI_PORT" \
        --disable-auto-launch \
        --use-pytorch-cross-attention \
        --force-fp16
) &

# Wait for ComfyUI to be ready
info "Waiting for ComfyUI to be ready..."
TIMEOUT=120
ELAPSED=0
while ! curl -s "http://127.0.0.1:$COMFYUI_PORT/system_stats" > /dev/null 2>&1; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
        warn "ComfyUI did not start within ${TIMEOUT}s — continuing anyway."
        warn "Generation/analysis will fail until ComfyUI is running."
        break
    fi
done

if [ "$ELAPSED" -lt "$TIMEOUT" ]; then
    info "ComfyUI is ready!"
fi

# ---------------------------------------------------------------
# 2. Start FastAPI backend
# ---------------------------------------------------------------
info "Starting FastAPI backend on port $BACKEND_PORT..."
(
    cd "$BACKEND_DIR"
    source .venv/bin/activate
    uvicorn main:app --reload --port "$BACKEND_PORT"
) &

sleep 2
info ""
info "==============================================" 
info "  VFX Scene Extension — all services running"
info "==============================================" 
info "  ComfyUI:   ${CYAN}http://127.0.0.1:$COMFYUI_PORT${NC}"
info "  Backend:   ${CYAN}http://127.0.0.1:$BACKEND_PORT${NC}"
info ""
info "  To start the frontend separately:"
info "    cd frontend && npm run dev"
info ""
info "  Press Ctrl+C to stop all services."
info "==============================================" 

# Wait for background jobs
wait
