# VFX Scene Extension

## Product Goal

VFX Scene Extension is a local-first, AI-powered compositing tool designed for visual effects artists and creative technologists working on Apple Silicon Macs. You upload a photograph or plate, and the tool automatically decomposes the scene into semantically meaningful background layers (sky, water, mountains, vegetation, buildings), generates precision alpha masks for each layer, and lets you interactively refine mask edges before using the isolated layers as inputs to AI-driven scene extension (outpainting, inpainting, image-to-image generation).

The target workflow:

1. **Upload** a plate or reference image.
2. **Analyze** — the system segments the scene into background categories and generates per-category alpha masks with clean, colour-aware edges.
3. **Refine** — hover over any mask to see the alpha matte. Where the AI is uncertain about a boundary (tree branches against sky, building silhouettes, shoreline spray), dashed zone indicators appear. Hover a zone to get a draggable slider that lets you manually push ambiguous pixels toward "include" or "exclude."
4. **Generate** — feed the refined masks and prompt into Flux (via ComfyUI) to extend, replace, or augment specific regions of the scene.

Everything runs locally. No cloud API keys, no per-image fees, no data leaving your machine.

---

## Architecture Overview

The system is a three-process stack coordinated by a single `start.sh` launcher:

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend — Next.js 15 (port 3000)                               │
│  Tailwind CSS · Shadcn UI · Lucide icons                         │
│  Dashboard with canvas, mask overlays, gallery, live status      │
└────────────────────────┬─────────────────────────────────────────┘
                         │  SSE (real-time progress)
                         │  REST (job submission, image upload)
┌────────────────────────┴─────────────────────────────────────────┐
│  Backend — FastAPI (port 8000)                                    │
│  Orchestration layer + local SegFormer segmentation               │
│  Endpoints: /api/generate, /api/analyze, /api/stream, /api/health │
└────────────────────────┬─────────────────────────────────────────┘
                         │  WebSocket (execution progress)
                         │  REST (prompt queue, image upload/download)
┌────────────────────────┴─────────────────────────────────────────┐
│  ComfyUI — Sidecar engine (port 8188, headless)                   │
│  Flux GGUF generation · Florence2 VLM analysis                    │
│  Custom nodes: ComfyUI-GGUF, ComfyUI-Florence2                   │
└──────────────────────────────────────────────────────────────────┘
```

### Why three processes?

| Process | Role | Why it's separate |
|---------|------|-------------------|
| **Frontend** | Interactive UI, canvas compositing, client-side mask manipulation | Runs in the browser; decoupled for hot-reload during development |
| **FastAPI** | API gateway, SSE streaming, segmentation + alpha matting | Keeps the custom mask pipeline (SegFormer + PyMatting) independent of ComfyUI's node system, where it would be harder to control and iterate on |
| **ComfyUI** | GPU-heavy generation via Flux GGUF; VLM analysis via Florence2 | Manages its own VRAM, model loading/unloading, and provides a battle-tested execution engine for diffusion workflows |

---

## Detailed Component Breakdown

### Frontend (`frontend/`)

**Stack:** Next.js 15 (App Router), Tailwind CSS, Shadcn UI, Lucide icons.

| File | Responsibility |
|------|---------------|
| `src/lib/use-sse.ts` | `useSSE` hook — opens an `EventSource` to `/api/stream`, maintains a job map, exposes `submitJob()` and `analyzeImage()`. Defines all TypeScript interfaces (`AnalysisResult`, `MaskData`, `AmbiguousZone`, `JobEvent`). |
| `src/components/dashboard.tsx` | Main layout — header, global progress bar, canvas area (drag-and-drop upload, image display, mask overlay), analysis results panel (scene context, foreground/background breakdown, category selector), live status sidebar, gallery strip. |
| `src/components/mask-overlay.tsx` | Interactive mask rendering. When the backend returns an `alpha_matte` and `zones` array for a mask, this component loads the alpha matte into an offscreen canvas, pre-computes a base display buffer, and renders the mask with per-zone bias adjustments. Draws dashed emerald zone indicators on hover. Shows a floating, draggable "Edge Adjustment" slider when the cursor enters an ambiguous zone. Falls back to a simple `<img>` overlay when no interactive zones exist. |
| `src/components/ui/*` | Shadcn primitives — Button, Card, Badge, Progress, ScrollArea, Separator. |

**Data flow:** The frontend never calls ComfyUI directly. All communication goes through FastAPI. Real-time progress arrives over a single SSE connection (`EventSource`). Job submission and image upload use standard `fetch` with `FormData`.

### Backend (`backend/`)

**Stack:** FastAPI, SSE-Starlette, Pillow, PyTorch, Transformers (SegFormer), PyMatting, SciPy, httpx, websockets.

#### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/generate` | POST | Submit a generation job. Accepts prompt, dimensions, steps, seed, optional base image and mask. Uploads images to ComfyUI, builds a workflow (txt2img / img2img / inpaint), queues it, and relays WebSocket progress via SSE. |
| `/api/analyze` | POST | Submit an analysis job. Accepts an image. Runs local SegFormer segmentation + PyMatting alpha refinement + ambiguous zone detection. Streams progress and the full `AnalysisResult` (description, categories, masks with alpha mattes and zone metadata) back via SSE. |
| `/api/stream` | GET | SSE endpoint. Each connected client gets a dedicated `asyncio.Queue`. Every job event (queued, status, step, complete, error) is broadcast to all subscribers. |
| `/api/health` | GET | Returns backend status and whether the ComfyUI sidecar is reachable. |

#### Mask Generation Pipeline

This is the core differentiator of the tool. The pipeline runs entirely inside FastAPI (no ComfyUI dependency):

```
Input image
    │
    ▼
SegFormer-B0 (ADE20K, ~15 MB)
    │  Semantic segmentation → 150-class pixel map
    │
    ▼
Category Extraction
    │  Map ADE20K class IDs to 5 background categories:
    │    sky [2], water [21,26], mountains [16],
    │    vegetation [4,9,17], buildings [1,25]
    │  Filter by minimum pixel coverage (0.5%)
    │
    ▼
Binary Region Mask (per category)
    │
    ▼
Trimap Construction
    │  Erode 10px → definite foreground (region)
    │  Dilate 20px → definite background (not region)
    │  Gap = uncertain boundary band
    │
    ▼
PyMatting — Closed-Form Alpha Matting
    │  Uses the original image's RGB pixel colours to
    │  solve for true alpha values in the boundary band.
    │  Edges follow real object silhouettes.
    │
    ▼
Ambiguous Zone Detection (SciPy connected-component labelling)
    │  Finds contiguous regions where 0.05 < alpha < 0.95
    │  Filters by minimum area (200px), caps at 12 zones
    │  Returns bounding box, centroid, mean alpha per zone
    │
    ▼
Structured MaskData output:
  {
    "display":      base64 PNG (inverted alpha for overlay rendering),
    "alpha_matte":  base64 PNG (raw alpha, 0–255),
    "zones":        [{ id, bbox, centroid, mean_alpha }, ...]
  }
```

#### ComfyUI Client (`comfyui_client.py`)

An async Python client that wraps ComfyUI's REST + WebSocket API:

- **`upload_image()`** — POST to `/upload/image`
- **`queue_prompt()`** — POST to `/prompt`
- **`run_workflow()`** — Queue a workflow, connect via WebSocket, stream progress events, wait for completion
- **`run_and_get_images()`** — Run a workflow and download all output images from `/view`
- **`health_check()`** / **`wait_ready()`** — Probe ComfyUI readiness on startup

#### Workflow Builder (`workflow_builder.py`)

Loads JSON workflow templates from `backend/workflows/` and injects runtime parameters (prompt, dimensions, seed, image filenames). Three generation templates (txt2img, img2img, inpaint) and one analysis template (Florence2 captioning + object detection).

### ComfyUI Sidecar (`comfyui/`)

A standard ComfyUI installation running headless in API mode. Not tracked in git — cloned separately per setup instructions.

**Custom nodes:**
- **ComfyUI-GGUF** — Loads quantized Flux model checkpoints (Q4/Q6 GGUF) so generation fits in 16 GB of unified memory on Apple Silicon.
- **ComfyUI-Florence2** — Runs the Florence2-base VLM for scene captioning and object detection.

**Models directory layout:**
```
comfyui/models/
├── unet/   ← Flux GGUF checkpoint (4–7 GB depending on quantization)
├── clip/   ← clip_l.safetensors + t5xxl_fp16.safetensors
└── vae/    ← ae.safetensors
```

---

## Key Design Decisions

**Local segmentation, not ComfyUI nodes.** SegFormer and PyMatting run inside FastAPI rather than as ComfyUI custom nodes. This gives direct control over the trimap construction, alpha matting parameters, and zone detection logic — all of which require tight iteration. ComfyUI's node graph is ideal for generation workflows but makes fine-grained mask post-processing cumbersome.

**Structured mask data, not flat images.** Each mask is a three-part payload: a display-ready overlay, a raw alpha matte (for client-side pixel manipulation), and a list of ambiguous zones with spatial metadata. This enables the frontend's interactive edge adjustment without round-tripping back to the server.

**SSE over WebSocket for the frontend.** The frontend only needs to receive events, never send them mid-stream. SSE is simpler to implement, auto-reconnects natively in browsers, and avoids the complexity of bidirectional WebSocket state management. The backend-to-ComfyUI link does use WebSocket because ComfyUI's progress API requires it.

**Sidecar process model.** ComfyUI runs as a separate process (not embedded) so it can manage its own VRAM lifecycle, crash independently without taking down the API, and be upgraded or swapped without touching the orchestration layer.

---

## Quick Start

### Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4), 16 GB+ RAM
- Python 3.10+
- Node.js 18+

### 1. Clone and set up ComfyUI

```bash
cd vfx-scene-extension
git clone https://github.com/comfyanonymous/ComfyUI.git comfyui
cd comfyui
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Install custom nodes:
```bash
cd custom_nodes
git clone https://github.com/kijai/ComfyUI-Florence2.git
git clone https://github.com/city96/ComfyUI-GGUF.git
```

### 2. Download models

| Model | Size | Destination |
|-------|------|-------------|
| [flux1-dev-Q4_K_S.gguf](https://huggingface.co/city96/FLUX.1-dev-gguf/tree/main) | ~4 GB | `comfyui/models/unet/` |
| [clip_l.safetensors](https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main) | ~235 MB | `comfyui/models/clip/` |
| [t5xxl_fp16.safetensors](https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main) | ~9.5 GB | `comfyui/models/clip/` |
| [ae.safetensors](https://huggingface.co/black-forest-labs/FLUX.1-dev/tree/main) | ~335 MB | `comfyui/models/vae/` |

Florence2-base is auto-downloaded on first analysis run.

### 3. Install backend dependencies

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Install frontend dependencies

```bash
cd frontend
npm install
```

### 5. Launch

```bash
# Start ComfyUI + FastAPI together:
./start.sh

# In a separate terminal, start the frontend:
cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Repository Structure

```
vfx-scene-extension/
├── backend/
│   ├── main.py                 # FastAPI app — endpoints, SSE, segmentation pipeline
│   ├── comfyui_client.py       # Async ComfyUI REST + WebSocket client
│   ├── workflow_builder.py     # JSON template loader with runtime param injection
│   ├── workflows/
│   │   ├── generate_txt2img.json
│   │   ├── generate_img2img.json
│   │   ├── generate_inpaint.json
│   │   └── analyze.json
│   └── requirements.txt
├── comfyui/                    # ComfyUI sidecar (not tracked in git)
├── frontend/
│   └── src/
│       ├── app/                # Next.js App Router (layout, page, globals)
│       ├── components/
│       │   ├── dashboard.tsx   # Main UI — canvas, analysis panel, sidebar, gallery
│       │   ├── mask-overlay.tsx # Interactive alpha matte canvas with zone sliders
│       │   └── ui/             # Shadcn component primitives
│       └── lib/
│           ├── use-sse.ts      # SSE hook + TypeScript interfaces
│           └── utils.ts        # Tailwind merge utility
├── start.sh                    # Launches ComfyUI + FastAPI with health checks
├── .gitignore
└── README.md
```
