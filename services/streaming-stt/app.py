from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

import numpy as np
import sherpa_onnx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

SAMPLE_RATE = 16_000
SHARED_TICKET_SECRET = os.environ.get("STREAMING_STT_TICKET_SECRET", "")
MODEL_DIR = Path(os.environ.get("SHERPA_MODEL_DIR", "/models/zipformer-en"))
MAX_AUDIO_MESSAGE_BYTES = 64 * 1024
MAX_AUDIO_BYTES_PER_SESSION = 2 * 1024 * 1024
MAX_ACTIVE_CONNECTIONS = int(os.environ.get("STREAMING_STT_MAX_CONNECTIONS", "2"))

if not SHARED_TICKET_SECRET:
    raise RuntimeError("STREAMING_STT_TICKET_SECRET is required")

_recognizer: sherpa_onnx.OnlineRecognizer | None = None
_recognizer_lock = Lock()
_decode_lock = asyncio.Lock()
_used_tickets: dict[str, int] = {}
_active_connections = 0
_active_lock = asyncio.Lock()


def _model_path(name: str) -> str:
    path = MODEL_DIR / name
    if not path.is_file():
        raise RuntimeError(f"missing streaming model file: {path}")
    return str(path)


def recognizer() -> sherpa_onnx.OnlineRecognizer:
    global _recognizer
    with _recognizer_lock:
        if _recognizer is None:
            _recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=_model_path("tokens.txt"),
                encoder=_model_path("encoder-epoch-99-avg-1-chunk-16-left-128.onnx"),
                decoder=_model_path("decoder-epoch-99-avg-1-chunk-16-left-128.onnx"),
                joiner=_model_path("joiner-epoch-99-avg-1-chunk-16-left-128.onnx"),
                num_threads=int(os.environ.get("STREAMING_STT_THREADS", "2")),
                sample_rate=SAMPLE_RATE,
                feature_dim=80,
                decoding_method="greedy_search",
                enable_endpoint_detection=False,
            )
        return _recognizer


def _decode_ticket(ticket: str) -> dict[str, object] | None:
    parts = ticket.split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    try:
        encoded = parts[0].encode("ascii")
        signature = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        expected = hmac.new(SHARED_TICKET_SECRET.encode("utf8"), encoded, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return None
        raw = base64.urlsafe_b64decode(parts[0] + "=" * (-len(parts[0]) % 4))
        if base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != parts[0]:
            return None
        value = json.loads(raw.decode("utf8"))
        if not isinstance(value, dict):
            return None
        if value.get("v") != 1 or value.get("aud") != "jarvis-streaming-stt":
            return None
        expires = value.get("exp")
        nonce = value.get("nonce")
        origin = value.get("origin")
        if not isinstance(expires, int) or expires <= int(time.time() * 1000):
            return None
        if not isinstance(nonce, str) or not nonce or not isinstance(origin, str) or not origin:
            return None
        return value
    except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
        return None


async def _claim_ticket(ticket: str, origin: str | None) -> bool:
    payload = _decode_ticket(ticket)
    if not payload or payload.get("origin") != origin:
        return False
    nonce = str(payload["nonce"])
    expires = int(payload["exp"])
    now = int(time.time() * 1000)
    async with _active_lock:
        for key, expiry in list(_used_tickets.items()):
            if expiry <= now:
                _used_tickets.pop(key, None)
        if nonce in _used_tickets:
            return False
        _used_tickets[nonce] = expires
    return True


def _decode(stream: sherpa_onnx.OnlineStream, done: bool = False) -> str:
    model = recognizer()
    if done:
        stream.input_finished()
    while model.is_ready(stream):
        model.decode_stream(stream)
    return str(model.get_result(stream)).strip()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Refuse readiness until ONNX files are mapped. This removes the otherwise
    # noticeable first-utterance model load while keeping the container CPU-only.
    recognizer()
    yield


app = FastAPI(title="Jarvis streaming STT", version="1.0", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {"ok": True, "engine": "sherpa-onnx", "sampleRate": SAMPLE_RATE}


@app.websocket("/v1/stream")
async def stream(websocket: WebSocket) -> None:
    global _active_connections
    await websocket.accept()
    async with _active_lock:
        if _active_connections >= MAX_ACTIVE_CONNECTIONS:
            await websocket.close(code=1013)
            return
        _active_connections += 1
    try:
        first = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        try:
            auth = json.loads(first)
        except json.JSONDecodeError:
            auth = None
        if not isinstance(auth, dict) or auth.get("type") != "auth" or not isinstance(auth.get("ticket"), str):
            await websocket.close(code=1008)
            return
        if not await _claim_ticket(auth["ticket"], websocket.headers.get("origin")):
            await websocket.close(code=1008)
            return
        model = recognizer()
        voice = model.create_stream()
        await websocket.send_json({"type": "ready", "sampleRate": SAMPLE_RATE})
        total_bytes = 0
        while True:
            packet = await websocket.receive()
            if packet.get("type") == "websocket.disconnect":
                return
            if packet.get("text") is not None:
                try:
                    control = json.loads(packet["text"])
                except json.JSONDecodeError:
                    control = None
                if isinstance(control, dict) and control.get("type") == "end":
                    async with _decode_lock:
                        result = await asyncio.to_thread(_decode, voice, True)
                    await websocket.send_json({"type": "final", "text": result})
                    return
                await websocket.close(code=1003)
                return
            audio = packet.get("bytes")
            if not isinstance(audio, bytes) or not audio or len(audio) > MAX_AUDIO_MESSAGE_BYTES or len(audio) % 2:
                await websocket.close(code=1009)
                return
            total_bytes += len(audio)
            if total_bytes > MAX_AUDIO_BYTES_PER_SESSION:
                await websocket.close(code=1009)
                return
            samples = np.frombuffer(audio, dtype="<i2").astype(np.float32) / 32768.0
            voice.accept_waveform(SAMPLE_RATE, samples)
            async with _decode_lock:
                result = await asyncio.to_thread(_decode, voice)
            await websocket.send_json({"type": "partial", "text": result})
    except (WebSocketDisconnect, asyncio.TimeoutError):
        return
    finally:
        async with _active_lock:
            _active_connections = max(0, _active_connections - 1)
