"""
Async client for the ComfyUI server.

Communicates via REST (prompt queueing, image upload/download, health)
and WebSocket (real-time execution progress).
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
import websockets

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[dict[str, Any]], None]


class ComfyUIClient:
    """Thin async wrapper around ComfyUI's server API."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8188):
        self.host = host
        self.port = port
        self.client_id = uuid.uuid4().hex
        self.base_url = f"http://{host}:{port}"
        self.ws_url = f"ws://{host}:{port}/ws?clientId={self.client_id}"
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)

    # ------------------------------------------------------------------
    # Health / readiness
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        try:
            r = await self._http.get("/system_stats")
            return r.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False

    async def wait_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        """Block until ComfyUI responds to health checks."""
        elapsed = 0.0
        while elapsed < timeout:
            if await self.health_check():
                logger.info("ComfyUI is ready at %s", self.base_url)
                return
            await asyncio.sleep(poll)
            elapsed += poll
        raise TimeoutError(f"ComfyUI not ready after {timeout}s at {self.base_url}")

    # ------------------------------------------------------------------
    # Image upload
    # ------------------------------------------------------------------

    async def upload_image(self, file_path: str | Path, subfolder: str = "") -> str:
        """
        Upload an image to ComfyUI's /upload/image endpoint.
        Returns the filename as stored by ComfyUI (used in LoadImage nodes).
        """
        p = Path(file_path)
        with open(p, "rb") as f:
            files = {"image": (p.name, f, "image/png")}
            data: dict[str, str] = {"overwrite": "true"}
            if subfolder:
                data["subfolder"] = subfolder
            r = await self._http.post("/upload/image", files=files, data=data)
            r.raise_for_status()
            body = r.json()
            return body["name"]

    # ------------------------------------------------------------------
    # Prompt queueing
    # ------------------------------------------------------------------

    async def queue_prompt(self, workflow: dict) -> str:
        """
        POST workflow JSON to /prompt.  Returns the prompt_id.
        """
        payload = {
            "prompt": workflow,
            "client_id": self.client_id,
        }
        r = await self._http.post("/prompt", json=payload)
        r.raise_for_status()
        return r.json()["prompt_id"]

    # ------------------------------------------------------------------
    # Result retrieval
    # ------------------------------------------------------------------

    async def get_history(self, prompt_id: str) -> dict:
        r = await self._http.get(f"/history/{prompt_id}")
        r.raise_for_status()
        return r.json().get(prompt_id, {})

    async def get_image_bytes(
        self,
        filename: str,
        subfolder: str = "",
        folder_type: str = "output",
    ) -> bytes:
        """Download a generated image from ComfyUI's /view endpoint."""
        params = {
            "filename": filename,
            "subfolder": subfolder,
            "type": folder_type,
        }
        r = await self._http.get("/view", params=params)
        r.raise_for_status()
        return r.content

    # ------------------------------------------------------------------
    # WebSocket progress streaming
    # ------------------------------------------------------------------

    async def run_workflow(
        self,
        workflow: dict,
        on_progress: Optional[ProgressCallback] = None,
    ) -> dict:
        """
        Queue a workflow and stream WebSocket events until execution completes.

        Returns the history entry for the prompt (contains output filenames).
        Calls ``on_progress(event_dict)`` for each WS message so the caller
        can relay to SSE subscribers.
        """
        async with websockets.connect(self.ws_url) as ws:
            prompt_id = await self.queue_prompt(workflow)
            logger.info("Queued ComfyUI prompt %s", prompt_id)

            while True:
                raw = await ws.recv()
                if isinstance(raw, bytes):
                    continue

                msg = json.loads(raw)
                msg_type = msg.get("type", "")
                data = msg.get("data", {})

                if on_progress:
                    on_progress({"ws_type": msg_type, **data})

                if msg_type == "executing" and data.get("node") is None:
                    if data.get("prompt_id") == prompt_id:
                        break

                if msg_type == "execution_error":
                    if data.get("prompt_id") == prompt_id:
                        raise RuntimeError(
                            f"ComfyUI execution error: "
                            f"{data.get('exception_message', 'unknown')}"
                        )

        history = await self.get_history(prompt_id)
        return history

    # ------------------------------------------------------------------
    # Convenience: run workflow and return output image bytes
    # ------------------------------------------------------------------

    async def run_and_get_images(
        self,
        workflow: dict,
        on_progress: Optional[ProgressCallback] = None,
    ) -> list[bytes]:
        """Run workflow, then download every output image."""
        history = await self.run_workflow(workflow, on_progress)
        outputs = history.get("outputs", {})
        images: list[bytes] = []
        for _node_id, node_output in outputs.items():
            for img_info in node_output.get("images", []):
                data = await self.get_image_bytes(
                    filename=img_info["filename"],
                    subfolder=img_info.get("subfolder", ""),
                    folder_type=img_info.get("type", "output"),
                )
                images.append(data)
        return images

    # ------------------------------------------------------------------
    # Convenience: run Florence2 workflow and return text outputs
    # ------------------------------------------------------------------

    async def run_and_get_texts(
        self,
        workflow: dict,
        on_progress: Optional[ProgressCallback] = None,
    ) -> dict[str, str]:
        """
        Run a Florence2 workflow and extract text results from node outputs.
        Returns {node_id: text_value} for every node that produced text.
        """
        history = await self.run_workflow(workflow, on_progress)
        outputs = history.get("outputs", {})
        texts: dict[str, str] = {}
        for node_id, node_output in outputs.items():
            if "text" in node_output:
                val = node_output["text"]
                if isinstance(val, list):
                    texts[node_id] = val[0] if val else ""
                else:
                    texts[node_id] = str(val)
            for key in ("caption", "string", "STRING"):
                if key in node_output:
                    val = node_output[key]
                    texts[node_id] = val[0] if isinstance(val, list) else str(val)
        return texts

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def close(self) -> None:
        await self._http.aclose()
