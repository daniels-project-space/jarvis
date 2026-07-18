"""Authenticated, pre-warmed cloud entry point for the upstream Voicebox API."""

from contextlib import asynccontextmanager
import hmac
import os

from fastapi import Request
from fastapi.responses import JSONResponse

from backend import config

config.set_data_dir(os.environ.get("VOICEBOX_DATA_DIR", "/app/data"))

from backend.app import app  # noqa: E402


_original_lifespan = app.router.lifespan_context


@asynccontextmanager
async def warm_voicebox(application):
    async with _original_lifespan(application):
        # Uvicorn does not report the service ready until the 1.7B model is in
        # GPU memory. The first Jarvis sentence therefore avoids model startup.
        from backend.backends import load_engine_model

        await load_engine_model("qwen", "1.7B")
        yield


app.router.lifespan_context = warm_voicebox


@app.middleware("http")
async def require_cloud_token(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    expected = os.environ.get("VOICEBOX_TTS_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not hmac.compare_digest(supplied, f"Bearer {expected}"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)
