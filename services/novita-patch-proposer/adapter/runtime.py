"""Local vLLM process management for the sealed endpoint.

The adapter never accepts a command from a request.  It starts exactly one
loopback-only vLLM process with the model and immutable revision from the
attestation it already validated.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
import subprocess
from typing import Final

import httpx

from .policy import AdapterConfig


UPSTREAM_BASE: Final = "http://127.0.0.1:8001"
UPSTREAM_HEALTH: Final = f"{UPSTREAM_BASE}/health"
UPSTREAM_COMPLETIONS: Final = f"{UPSTREAM_BASE}/v1/chat/completions"
VLLM_PROCESS_ENVIRONMENT: Final = {
    "HOME": "/home/jarvis",
    "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
}


def vllm_environment() -> dict[str, str]:
    """Return the complete child environment; never inherit adapter secrets."""
    return dict(VLLM_PROCESS_ENVIRONMENT)


def vllm_command(config: AdapterConfig) -> list[str]:
    """Return a fixed argv list.  No shell is involved at any point."""
    return [
        "vllm",
        "serve",
        config.model_id,
        "--host", "127.0.0.1",
        "--port", "8001",
        "--served-model-name", config.model_id,
        "--revision", config.model_revision,
        "--quantization", "gptq_marlin",
        "--max-model-len", "4096",
        "--max-num-seqs", "1",
        "--gpu-memory-utilization", "0.85",
        "--download-dir", "/models",
        "--disable-log-requests",
    ]


@dataclass
class ModelRuntime:
    config: AdapterConfig
    process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if self.process is not None:
            return
        Path("/models").mkdir(parents=True, exist_ok=True)
        # Never inherit the adapter environment. In particular, the endpoint
        # bearer, full attestation, account credential, and any HF/token value
        # are unavailable to the model subprocess.
        self.process = subprocess.Popen(
            vllm_command(self.config),
            stdin=subprocess.DEVNULL,
            stdout=None,
            stderr=None,
            close_fds=True,
            shell=False,
            env=vllm_environment(),
        )

    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    async def healthy(self) -> bool:
        if not self.running():
            return False
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(1.5), follow_redirects=False) as client:
                response = await client.get(UPSTREAM_HEALTH)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(self.process.wait), timeout=15)
            except TimeoutError:
                self.process.kill()
                await asyncio.to_thread(self.process.wait)
        self.process = None
