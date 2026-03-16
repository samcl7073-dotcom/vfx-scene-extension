# VFX Scene Extension

AI-powered scene extension and compositing tool with real-time progress streaming, powered by ComfyUI.

## Architecture

```
vfx-scene-extension/
├── backend/              # FastAPI gateway + SSE streaming
│   ├── main.py           # API endpoints, orchestration
│   ├── comfyui_client.py # WebSocket + REST client for ComfyUI
│   ├── workflow_builder.py # JSON template loader
│   ├── workflows/        # ComfyUI API workflow templates
│   │   ├── generate_txt2img.json
│   │   ├── generate_img2img.json
│   │   ├── generate_inpaint.json
│   │   └── analyze.json
│   └── requirements.txt
├── comfyui/              # ComfyUI sidecar server (port 8188)
│   ├── custom_nodes/
│   │   ├── ComfyUI-Florence2/   # VLM scene analysis
│   │   └── ComfyUI-GGUF/        # Quantized model loading
│   └── models/           # Place model files here
│       ├── unet/         # Flux GGUF checkpoints
│       ├── clip/         # CLIP + T5 text encoders
│       └── vae/          # VAE decoder
├── frontend/             # Next.js 15 + Tailwind + Shadcn UI
│   └── src/
│       ├── app/
│       ├── components/
│       └── lib/
├── start.sh              # Launches ComfyUI + FastAPI together
└── README.md
```

## How It Works

```
Frontend (Next.js :3000)
    ↕ SSE + REST
FastAPI Gateway (:8000)
    ↕ WebSocket + REST
ComfyUI Engine (:8188)
    → Flux GGUF (generation)
    → Florence2 (scene analysis)
    → SegFormer (segmentation masks, runs locally in FastAPI)
```

FastAPI acts as a thin orchestration layer:
- Translates frontend requests into ComfyUI workflow JSON
- Streams ComfyUI WebSocket progress to the frontend via SSE
- Runs lightweight SegFormer segmentation locally for mask generation

## Quick Start

### 1. Download Required Models

Place these files in the ComfyUI models directory:

**Flux GGUF checkpoint** (pick one based on your RAM):
- 16 GB RAM: `flux1-dev-Q4_K_S.gguf` (~4 GB) → `comfyui/models/unet/`
- 32 GB RAM: `flux1-dev-Q6_K.gguf` (~7 GB) → `comfyui/models/unet/`

Download from: https://huggingface.co/city96/FLUX.1-dev-gguf/tree/main

**CLIP text encoders** → `comfyui/models/clip/`:
- `clip_l.safetensors` — https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main
- `t5xxl_fp16.safetensors` — https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main

**VAE** → `comfyui/models/vae/`:
- `ae.safetensors` — https://huggingface.co/black-forest-labs/FLUX.1-dev/tree/main

**Florence2** (auto-downloaded on first analysis run via ComfyUI-Florence2 node)

### 2. Start All Services

```bash
./start.sh
```

This launches ComfyUI (headless, port 8188) and FastAPI (port 8000).

### 3. Start the Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Alternative: Start Services Individually

```bash
# Terminal 1 — ComfyUI
cd comfyui && source .venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --use-pytorch-cross-attention --force-fp16

# Terminal 2 — FastAPI
cd backend && source .venv/bin/activate
uvicorn main:app --reload --port 8000

# Terminal 3 — Frontend
cd frontend && npm run dev
```

## Features

- **Main Canvas**: Drag-and-drop image upload with live preview
- **Live Status Sidebar**: Real-time job progress via Server-Sent Events
- **Scene Analysis**: Florence2 VLM for scene description and object detection
- **Background Segmentation**: SegFormer-based masks for sky, water, mountains, vegetation, buildings
- **Interactive Mask Overlays**: Click background categories to see highlighted regions; hover for alpha masks
- **Image Generation**: Flux GGUF via ComfyUI (txt2img, img2img, inpainting)
- **Gallery**: Session history of all generated images

## Memory Notes (16 GB Mac)

- Use Q4 GGUF quantization for Flux (~4 GB) to leave room for other models
- ComfyUI auto-unloads models when switching between generation and analysis
- SegFormer runs in FastAPI and is only ~15 MB
- Florence2-base is ~450 MB (auto-downloaded on first use)
