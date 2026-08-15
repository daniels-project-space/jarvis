"""HTTP boundary for the sealed Novita custom endpoint."""

from __future__ import annotations

from contextlib import asynccontextmanager
import os
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx

from .policy import (
    AdapterConfig,
    PolicyViolation,
    authorizes,
    completion_byte_limit,
    load_config,
    normalize_completion,
    validate_request,
)
from .runtime import ModelRuntime, UPSTREAM_COMPLETIONS


async def bounded_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise HTTPException(status_code=413, detail="request_too_large")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_content_length") from exc
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(status_code=413, detail="request_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


async def response_body(response: httpx.Response, limit: int) -> bytes:
    declared = response.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                raise PolicyViolation("completion_too_large")
        except ValueError as exc:
            raise PolicyViolation("invalid_model_response") from exc
    data = await response.aread()
    if len(data) > limit:
        raise PolicyViolation("completion_too_large")
    return data


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    config = load_config(os.environ)
    runtime = ModelRuntime(config)
    runtime.start()
    app.state.config = config
    app.state.runtime = runtime
    try:
        yield
    finally:
        await runtime.stop()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def config_for(request: Request) -> AdapterConfig:
    return request.app.state.config  # type: ignore[no-any-return]


def runtime_for(request: Request) -> ModelRuntime:
    return request.app.state.runtime  # type: ignore[no-any-return]


@app.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    if not await runtime_for(request).healthy():
        raise HTTPException(status_code=503, detail="model_unavailable")
    return JSONResponse({"status": "ready"})


@app.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    config = config_for(request)
    if not authorizes(authorization, config):
        raise HTTPException(status_code=401, detail="unauthorized")
    body = await bounded_body(request, config.limits.max_input_bytes)
    try:
        payload, allowed_paths = validate_request(body, config)
    except PolicyViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    runtime = runtime_for(request)
    if not runtime.running():
        raise HTTPException(status_code=503, detail="model_unavailable")
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(config.limits.timeout_ms / 1000),
            follow_redirects=False,
        ) as client:
            upstream = await client.post(UPSTREAM_COMPLETIONS, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="model_unavailable") from exc
    if upstream.status_code != 200:
        # Deliberately discard upstream text: prompt fragments and worker errors
        # must never become a caller-visible side channel.
        raise HTTPException(status_code=502, detail="model_request_failed")
    if "application/json" not in upstream.headers.get("content-type", "").lower():
        raise HTTPException(status_code=502, detail="invalid_model_response")
    try:
        result = normalize_completion(
            await response_body(upstream, completion_byte_limit(config)),
            config,
            allowed_paths,
        )
    except PolicyViolation as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse(result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("adapter.app:app", host="0.0.0.0", port=8080, access_log=False, log_level="warning")
