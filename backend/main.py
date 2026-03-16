import asyncio
import base64
import io
import json
import logging
import random
import re
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from comfyui_client import ComfyUIClient
from workflow_builder import build_generate_workflow, build_analyze_workflow

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8188

# ---------------------------------------------------------------------------
# SSE infrastructure
# ---------------------------------------------------------------------------
_event_loop: Optional[asyncio.AbstractEventLoop] = None
_subscribers: list[asyncio.Queue] = []


def _broadcast(payload: dict) -> None:
    """Thread-safe push to every SSE subscriber."""
    raw = json.dumps(payload)
    loop = _event_loop
    if loop is None:
        return
    for q in list(_subscribers):
        loop.call_soon_threadsafe(q.put_nowait, raw)


async def _broadcast_async(payload: dict) -> None:
    """Async push to every SSE subscriber (use from async context)."""
    raw = json.dumps(payload)
    for q in list(_subscribers):
        q.put_nowait(raw)


# ---------------------------------------------------------------------------
# SegFormer semantic segmentation (kept locally — lightweight, custom logic)
# ---------------------------------------------------------------------------
SEG_MODEL_NAME = "nvidia/segformer-b0-finetuned-ade-512-512"

_seg_model = None
_seg_processor = None
_seg_lock = threading.Lock()

_BG_CATEGORY_ADE20K: dict[str, list[int]] = {
    "sky": [2],
    "sea_or_water": [21, 26],
    "mountains_or_hills": [16],
    "forests_or_vegetation": [4, 9, 17],
    "cityscape_or_buildings": [1, 25],
}


def _load_segmenter():
    global _seg_model, _seg_processor
    if _seg_model is not None:
        return _seg_model, _seg_processor
    with _seg_lock:
        if _seg_model is not None:
            return _seg_model, _seg_processor

        logger.info("Loading SegFormer: %s (~15 MB)", SEG_MODEL_NAME)
        import torch
        from transformers import (
            SegformerImageProcessor,
            SegformerForSemanticSegmentation,
        )

        _seg_processor = SegformerImageProcessor.from_pretrained(SEG_MODEL_NAME)
        _seg_model = SegformerForSemanticSegmentation.from_pretrained(SEG_MODEL_NAME)
        _seg_model.eval()
        logger.info("SegFormer loaded")
        return _seg_model, _seg_processor


TRIMAP_ERODE_PX = 10
TRIMAP_DILATE_PX = 20
ZONE_ALPHA_LO = 0.05
ZONE_ALPHA_HI = 0.95
ZONE_MIN_AREA = 200
ZONE_MAX_COUNT = 12


def _refine_mask(image_rgb: "np.ndarray", region_mask: "np.ndarray") -> "np.ndarray":
    """
    Refine a binary segmentation mask using closed-form alpha matting.

    1. Erode the mask  → pixels that are *definitely* the region
    2. Dilate the mask → pixels that are *definitely not* the region
    3. The gap between them is the uncertain boundary band
    4. PyMatting solves for true alpha in the boundary using the image's
       colour information, so edges snap to real object silhouettes.

    Returns an alpha array (float64, 0.0–1.0) where 1.0 = region.
    """
    import numpy as np
    from scipy.ndimage import binary_erosion, binary_dilation
    from pymatting import estimate_alpha_cf

    eroded = binary_erosion(region_mask, iterations=TRIMAP_ERODE_PX)
    dilated = binary_dilation(region_mask, iterations=TRIMAP_DILATE_PX)

    trimap = np.full(region_mask.shape, 0.5, dtype=np.float64)
    trimap[eroded] = 1.0
    trimap[~dilated] = 0.0

    img_f64 = image_rgb.astype(np.float64) / 255.0

    alpha = estimate_alpha_cf(img_f64, trimap)
    return np.clip(alpha, 0.0, 1.0)


def _find_ambiguous_zones(alpha: "np.ndarray") -> list[dict]:
    """Find connected components where alpha is between the lo/hi thresholds."""
    import numpy as np
    from scipy.ndimage import label as ndlabel

    ambiguous = (alpha > ZONE_ALPHA_LO) & (alpha < ZONE_ALPHA_HI)
    labeled, num_features = ndlabel(ambiguous)

    zones: list[dict] = []
    for i in range(1, num_features + 1):
        component = labeled == i
        area = int(component.sum())
        if area < ZONE_MIN_AREA:
            continue

        ys, xs = np.where(component)
        zones.append({
            "id": f"z{i}",
            "bbox": {
                "x": int(xs.min()),
                "y": int(ys.min()),
                "w": int(xs.max() - xs.min() + 1),
                "h": int(ys.max() - ys.min() + 1),
            },
            "centroid": {"x": int(xs.mean()), "y": int(ys.mean())},
            "mean_alpha": round(float(alpha[component].mean()), 3),
        })

    zones.sort(key=lambda z: z["bbox"]["w"] * z["bbox"]["h"], reverse=True)
    return zones[:ZONE_MAX_COUNT]


def _mask_to_structured(
    alpha_arr: "np.ndarray",
    alpha_raw: "np.ndarray | None",
) -> dict:
    """Package a mask array + optional raw alpha into the structured MaskData dict."""
    mask_img = Image.fromarray(alpha_arr, mode="L")
    buf = io.BytesIO()
    mask_img.save(buf, format="PNG")
    display_b64 = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"

    matte_b64 = None
    zones: list[dict] = []
    if alpha_raw is not None:
        import numpy as np
        matte_arr = (alpha_raw * 255).clip(0, 255).astype(np.uint8)
        matte_img = Image.fromarray(matte_arr, mode="L")
        matte_buf = io.BytesIO()
        matte_img.save(matte_buf, format="PNG")
        matte_b64 = f"data:image/png;base64,{base64.b64encode(matte_buf.getvalue()).decode()}"
        zones = _find_ambiguous_zones(alpha_raw)

    return {"display": display_b64, "alpha_matte": matte_b64, "zones": zones}


def _generate_masks(image_path: str, bg_elements: dict) -> dict[str, dict]:
    """
    Run SegFormer on the image and produce a refined base64 PNG mask for
    each detected background category.  Mask convention: region = black (0),
    rest = white (255), with smooth edges refined by closed-form alpha matting.
    """
    import numpy as np
    import torch

    seg_model, seg_proc = _load_segmenter()
    pil_img = Image.open(image_path).convert("RGB")
    img_np = np.array(pil_img)

    inputs = seg_proc(images=pil_img, return_tensors="pt")
    with torch.no_grad():
        outputs = seg_model(**inputs)

    seg_map = seg_proc.post_process_semantic_segmentation(
        outputs, target_sizes=[(pil_img.height, pil_img.width)]
    )[0]

    seg_np = seg_map.cpu().numpy()

    masks: dict[str, dict] = {}
    for category, class_ids in _BG_CATEGORY_ADE20K.items():
        if not bg_elements.get(category):
            continue

        region = np.zeros(seg_np.shape, dtype=bool)
        for cid in class_ids:
            region |= (seg_np == cid)

        if region.sum() == 0:
            continue

        alpha_raw = None
        try:
            alpha_raw = _refine_mask(img_np, region)
            alpha_arr = ((1.0 - alpha_raw) * 255).clip(0, 255).astype(np.uint8)
        except Exception:
            logger.warning("Alpha matting failed for %s, using binary mask", category)
            alpha_arr = np.where(region, 0, 255).astype(np.uint8)

        masks[category] = _mask_to_structured(alpha_arr, alpha_raw)

    return masks


# ---------------------------------------------------------------------------
# Florence2 output → AnalysisResult conversion
# ---------------------------------------------------------------------------

_BG_KEYWORDS: dict[str, list[str]] = {
    "sky": ["sky", "skies", "cloud", "clouds"],
    "sun_or_moon": ["sun", "moon", "sunrise", "sunset"],
    "sea_or_water": ["sea", "water", "ocean", "river", "lake", "pond", "waterfall"],
    "mountains_or_hills": ["mountain", "mountains", "hill", "hills", "cliff"],
    "forests_or_vegetation": [
        "forest", "forests", "tree", "trees", "vegetation", "bush", "grass",
    ],
    "cityscape_or_buildings": [
        "city", "cityscape", "building", "buildings", "skyscraper", "tower",
    ],
}


def _caption_to_analysis(
    caption: str,
    detected_objects: list[str],
) -> dict:
    """
    Convert Florence2 caption + OD labels into the AnalysisResult shape
    the frontend expects.
    """
    caption_lower = caption.lower()

    bg_elements: dict = {}
    for category, keywords in _BG_KEYWORDS.items():
        bg_elements[category] = any(kw in caption_lower for kw in keywords)
    bg_elements["other"] = []

    active_bg_words: set[str] = set()
    for cat, kws in _BG_KEYWORDS.items():
        if bg_elements.get(cat):
            active_bg_words.update(kws)

    foreground = [
        obj for obj in detected_objects
        if obj.strip().lower() not in active_bg_words
    ]

    colors: list[str] = []
    for color in [
        "red", "blue", "green", "yellow", "orange", "purple", "white",
        "black", "brown", "golden", "silver", "pink", "grey", "gray",
    ]:
        if color in caption_lower:
            colors.append(color)

    lighting = "unknown"
    for hint, label in [
        ("sunset", "warm sunset lighting"),
        ("sunrise", "warm sunrise lighting"),
        ("golden hour", "golden hour"),
        ("night", "nighttime / low light"),
        ("overcast", "overcast / diffuse"),
        ("sunny", "bright sunlight"),
        ("bright", "bright ambient"),
    ]:
        if hint in caption_lower:
            lighting = label
            break

    depth = "mid"
    if any(w in caption_lower for w in ["distant", "panorama", "horizon"]):
        depth = "far"
    elif any(w in caption_lower for w in ["close-up", "closeup", "macro", "portrait"]):
        depth = "near"

    return {
        "description": caption.strip()[:300],
        "foreground_elements": foreground[:20],
        "background_elements": bg_elements,
        "dominant_colors": colors[:5],
        "lighting": lighting,
        "depth_hint": depth,
    }


# ---------------------------------------------------------------------------
# ComfyUI-backed generation pipeline
# ---------------------------------------------------------------------------

async def _run_comfyui_generation(
    client: ComfyUIClient,
    job_id: str,
    prompt: str,
    width: int,
    height: int,
    num_steps: int,
    seed: int,
    image_path: Optional[str] = None,
    mask_path: Optional[str] = None,
    denoise: float = 1.0,
) -> None:
    try:
        await _broadcast_async({
            "type": "status",
            "job_id": job_id,
            "message": "Preparing workflow...",
            "progress": 5,
        })

        image_filename = None
        mask_filename = None
        if image_path:
            image_filename = await client.upload_image(image_path)
        if mask_path:
            mask_filename = await client.upload_image(mask_path)

        wf = build_generate_workflow(
            prompt=prompt,
            width=width,
            height=height,
            steps=num_steps,
            seed=seed,
            denoise=denoise,
            image_filename=image_filename,
            mask_filename=mask_filename,
        )

        await _broadcast_async({
            "type": "status",
            "job_id": job_id,
            "message": "Queued in ComfyUI — loading model...",
            "progress": 10,
        })

        current_step = 0

        def on_progress(evt: dict):
            nonlocal current_step
            ws_type = evt.get("ws_type", "")

            if ws_type == "progress":
                value = evt.get("value", 0)
                maximum = evt.get("max", 1)
                current_step = value
                pct = int((value / max(maximum, 1)) * 80) + 10
                _broadcast({
                    "type": "step",
                    "job_id": job_id,
                    "message": f"Processing Step {value}/{maximum}...",
                    "step": value,
                    "total_steps": maximum,
                    "progress": min(pct, 90),
                })
            elif ws_type == "executing":
                node = evt.get("node")
                if node:
                    _broadcast({
                        "type": "status",
                        "job_id": job_id,
                        "message": f"Executing node {node}...",
                        "progress": min(current_step * 5 + 10, 85),
                    })

        image_bytes_list = await client.run_and_get_images(wf, on_progress)

        if not image_bytes_list:
            raise RuntimeError("ComfyUI returned no images")

        img_bytes = image_bytes_list[0]

        output_path = OUTPUT_DIR / f"{job_id}.png"
        output_path.write_bytes(img_bytes)

        b64 = base64.b64encode(img_bytes).decode()

        await _broadcast_async({
            "type": "complete",
            "job_id": job_id,
            "message": "Generation complete",
            "image_data": f"data:image/png;base64,{b64}",
            "progress": 100,
        })

    except Exception as exc:
        logger.exception("ComfyUI generation failed for job %s", job_id)
        await _broadcast_async({
            "type": "error",
            "job_id": job_id,
            "message": str(exc),
            "progress": 0,
        })


# ---------------------------------------------------------------------------
# Local analysis pipeline (SegFormer-driven detection + mask generation)
# ---------------------------------------------------------------------------

_MIN_CATEGORY_COVERAGE = 0.005  # 0.5% of pixels to count as "detected"

_ADE20K_LABEL_NAMES: dict[str, str] = {
    "sky": "sky",
    "sea_or_water": "water",
    "mountains_or_hills": "mountains",
    "forests_or_vegetation": "vegetation",
    "cityscape_or_buildings": "buildings",
}


def _analyze_and_mask(image_path: str) -> dict:
    """
    Run SegFormer once, detect which background categories are present
    (by pixel coverage), generate refined masks for detected categories,
    and return a complete AnalysisResult dict.
    """
    import numpy as np
    import torch

    seg_model, seg_proc = _load_segmenter()
    pil_img = Image.open(image_path).convert("RGB")
    img_np = np.array(pil_img)

    inputs = seg_proc(images=pil_img, return_tensors="pt")
    with torch.no_grad():
        outputs = seg_model(**inputs)

    seg_map = seg_proc.post_process_semantic_segmentation(
        outputs, target_sizes=[(pil_img.height, pil_img.width)]
    )[0]
    seg_np = seg_map.cpu().numpy()
    total_pixels = seg_np.size

    bg_elements: dict = {
        "sky": False,
        "sun_or_moon": False,
        "sea_or_water": False,
        "mountains_or_hills": False,
        "forests_or_vegetation": False,
        "cityscape_or_buildings": False,
        "other": [],
    }
    masks: dict[str, dict] = {}
    detected_parts: list[str] = []

    for category, class_ids in _BG_CATEGORY_ADE20K.items():
        region = np.zeros(seg_np.shape, dtype=bool)
        for cid in class_ids:
            region |= (seg_np == cid)

        coverage = region.sum() / total_pixels
        if coverage < _MIN_CATEGORY_COVERAGE:
            continue

        bg_elements[category] = True
        detected_parts.append(_ADE20K_LABEL_NAMES.get(category, category))

        alpha_raw = None
        try:
            alpha_raw = _refine_mask(img_np, region)
            alpha_arr = ((1.0 - alpha_raw) * 255).clip(0, 255).astype(np.uint8)
        except Exception:
            logger.warning("Alpha matting failed for %s, using binary mask", category)
            alpha_arr = np.where(region, 0, 255).astype(np.uint8)

        masks[category] = _mask_to_structured(alpha_arr, alpha_raw)

    description = (
        f"Scene containing {', '.join(detected_parts)}."
        if detected_parts
        else "Scene with no recognized background categories."
    )

    return {
        "description": description,
        "foreground_elements": [],
        "background_elements": bg_elements,
        "dominant_colors": [],
        "lighting": "unknown",
        "depth_hint": "mid",
        "masks": masks,
    }


async def _run_analysis(
    job_id: str,
    image_path: str,
) -> None:
    """Run local SegFormer analysis + mask generation."""
    try:
        await _broadcast_async({
            "type": "status",
            "kind": "analyze",
            "job_id": job_id,
            "message": "Loading segmentation model...",
            "progress": 10,
        })

        loop = asyncio.get_running_loop()

        await _broadcast_async({
            "type": "status",
            "kind": "analyze",
            "job_id": job_id,
            "message": "Running segmentation analysis...",
            "progress": 30,
        })

        analysis = await loop.run_in_executor(None, _analyze_and_mask, image_path)

        await _broadcast_async({
            "type": "complete",
            "kind": "analyze",
            "job_id": job_id,
            "message": "Analysis complete",
            "progress": 100,
            "analysis": analysis,
        })

    except Exception as exc:
        logger.exception("Analysis failed for job %s", job_id)
        await _broadcast_async({
            "type": "error",
            "kind": "analyze",
            "job_id": job_id,
            "message": str(exc),
            "progress": 0,
        })


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

_comfy: Optional[ComfyUIClient] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _event_loop, _comfy
    _event_loop = asyncio.get_running_loop()

    _comfy = ComfyUIClient(host=COMFYUI_HOST, port=COMFYUI_PORT)
    try:
        await _comfy.wait_ready(timeout=120)
    except TimeoutError:
        logger.warning(
            "ComfyUI not reachable at %s:%s — generation/analysis will fail "
            "until ComfyUI is started. Run start.sh or start ComfyUI manually.",
            COMFYUI_HOST,
            COMFYUI_PORT,
        )

    yield

    if _comfy:
        await _comfy.close()


app = FastAPI(title="VFX Scene Extension API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
app.mount("/outputs", StaticFiles(directory="outputs"), name="outputs")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class JobOut(BaseModel):
    job_id: str
    status: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/generate", response_model=JobOut)
async def generate(
    prompt: str = Form("Extend this scene seamlessly with photorealistic detail"),
    width: int = Form(1024),
    height: int = Form(768),
    steps: int = Form(8),
    seed: Optional[int] = Form(None),
    image_strength: float = Form(0.75),
    image: Optional[UploadFile] = File(None),
    mask: Optional[UploadFile] = File(None),
):
    if _comfy is None:
        raise HTTPException(503, "ComfyUI client not initialized")

    job_id = uuid.uuid4().hex[:12]
    actual_seed = seed if seed is not None else random.randint(0, 2**32 - 1)

    saved_image_path: Optional[str] = None
    saved_mask_path: Optional[str] = None

    if image is not None:
        if not image.content_type or not image.content_type.startswith("image/"):
            raise HTTPException(400, "image must be an image file")
        dest = UPLOAD_DIR / f"{job_id}_base.png"
        img = Image.open(io.BytesIO(await image.read())).convert("RGB")
        img.save(str(dest))
        saved_image_path = str(dest)

    if mask is not None:
        if not mask.content_type or not mask.content_type.startswith("image/"):
            raise HTTPException(400, "mask must be an image file")
        dest = UPLOAD_DIR / f"{job_id}_mask.png"
        m = Image.open(io.BytesIO(await mask.read())).convert("L")
        m.save(str(dest))
        saved_mask_path = str(dest)

    if saved_mask_path and not saved_image_path:
        raise HTTPException(400, "mask requires a base image")

    await _broadcast_async({
        "type": "queued",
        "job_id": job_id,
        "message": "Job queued",
        "progress": 0,
    })

    denoise = 1.0 - image_strength if saved_image_path else 1.0

    asyncio.create_task(
        _run_comfyui_generation(
            client=_comfy,
            job_id=job_id,
            prompt=prompt,
            width=width,
            height=height,
            num_steps=steps,
            seed=actual_seed,
            image_path=saved_image_path,
            mask_path=saved_mask_path,
            denoise=denoise,
        )
    )

    return JobOut(job_id=job_id, status="queued")


@app.post("/api/analyze", response_model=JobOut)
async def analyze(image: UploadFile = File(...)):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "Only image files are accepted")

    job_id = uuid.uuid4().hex[:12]
    dest = UPLOAD_DIR / f"{job_id}_analyze.png"
    img = Image.open(io.BytesIO(await image.read())).convert("RGB")
    img.save(str(dest))

    await _broadcast_async({
        "type": "queued",
        "kind": "analyze",
        "job_id": job_id,
        "message": "Analysis queued",
        "progress": 0,
    })

    asyncio.create_task(
        _run_analysis(
            job_id=job_id,
            image_path=str(dest),
        )
    )

    return JobOut(job_id=job_id, status="analyzing")


@app.get("/api/stream")
async def stream():
    """SSE endpoint – streams JSON events for every job."""
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.append(queue)

    async def event_generator():
        try:
            while True:
                raw = await queue.get()
                yield {"event": "job_update", "data": raw}
        except asyncio.CancelledError:
            pass
        finally:
            if queue in _subscribers:
                _subscribers.remove(queue)

    return EventSourceResponse(event_generator())


@app.get("/api/health")
async def health():
    comfy_ok = await _comfy.health_check() if _comfy else False
    return {
        "status": "ok",
        "comfyui": "connected" if comfy_ok else "disconnected",
    }
