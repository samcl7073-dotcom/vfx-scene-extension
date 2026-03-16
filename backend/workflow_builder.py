"""
Build ComfyUI workflow dicts from JSON templates with runtime parameters.

Each ``build_*`` function deep-copies a template and injects the caller's
values (prompt text, dimensions, seed, filenames, etc.).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Optional

_TEMPLATES_DIR = Path(__file__).parent / "workflows"


def _load_template(name: str) -> dict:
    path = _TEMPLATES_DIR / name
    with open(path) as f:
        return json.load(f)


# ------------------------------------------------------------------
# Image generation
# ------------------------------------------------------------------

def build_generate_workflow(
    prompt: str,
    width: int = 1024,
    height: int = 768,
    steps: int = 8,
    seed: int = 0,
    cfg: float = 3.5,
    denoise: float = 1.0,
    image_filename: Optional[str] = None,
    mask_filename: Optional[str] = None,
) -> dict:
    """
    Return a ComfyUI API workflow dict for Flux image generation.

    Automatically selects the right template:
    - txt2img  (no image, no mask)
    - img2img  (image, no mask)
    - inpaint  (image + mask)
    """
    if image_filename and mask_filename:
        wf = _load_template("generate_inpaint.json")
        wf["10"]["inputs"]["image"] = image_filename
        wf["12"]["inputs"]["image"] = mask_filename
    elif image_filename:
        wf = _load_template("generate_img2img.json")
        wf["10"]["inputs"]["image"] = image_filename
    else:
        wf = _load_template("generate_txt2img.json")

    wf["4"]["inputs"]["text"] = prompt

    sampler = wf["7"]["inputs"]
    sampler["seed"] = seed
    sampler["steps"] = steps
    sampler["cfg"] = cfg
    sampler["denoise"] = denoise

    if "6" in wf and "width" in wf["6"].get("inputs", {}):
        wf["6"]["inputs"]["width"] = width
        wf["6"]["inputs"]["height"] = height

    return wf


# ------------------------------------------------------------------
# Florence2 analysis
# ------------------------------------------------------------------

def build_analyze_workflow(image_filename: str) -> dict:
    """
    Return a ComfyUI API workflow for Florence2 scene analysis.

    Runs two tasks:
    - Node 3: more_detailed_caption  (rich scene description)
    - Node 4: object_detection       (foreground objects with labels)
    """
    wf = _load_template("analyze.json")
    wf["2"]["inputs"]["image"] = image_filename
    return wf
