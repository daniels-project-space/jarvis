from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("STT_MODEL", "small.en")
MODEL_DEVICE = os.environ.get("STT_DEVICE", "auto")
MODEL_COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")
MODEL_BEAM_SIZE = max(1, min(5, int(os.environ.get("STT_BEAM_SIZE", "5"))))
MODEL_DOWNLOAD_ROOT = os.environ.get("STT_MODEL_DIR", "/models")
SHARED_SECRET = os.environ.get("STT_SHARED_SECRET", "")
MAX_AUDIO_BYTES = int(os.environ.get("STT_MAX_AUDIO_BYTES", str(20 * 1024 * 1024)))
ALLOWED_ORIGINS = tuple(
    origin.strip()
    for origin in os.environ.get(
        "STT_ALLOWED_ORIGINS",
        "https://jarvis-orcin-six.vercel.app",
    ).split(",")
    if origin.strip()
)
TICKET_AUDIENCE = "jarvis-final-stt"
TICKET_MAX_FUTURE_MS = 75_000

if not SHARED_SECRET:
    raise RuntimeError("STT_SHARED_SECRET is required; refusing to expose unauthenticated speech recognition")

_model: WhisperModel | None = None
_model_lock = Lock()
_used_tickets: dict[str, int] = {}
_ticket_lock = Lock()


def _decode_ticket(ticket: str, now_ms: int | None = None) -> dict[str, object] | None:
    parts = ticket.split(".")
    if len(parts) != 2 or not all(parts):
        return None
    encoded, supplied_signature = parts
    expected = hmac.new(SHARED_SECRET.encode(), encoded.encode(), hashlib.sha256).digest()
    try:
        supplied = base64.urlsafe_b64decode(supplied_signature + "=" * (-len(supplied_signature) % 4))
        if not hmac.compare_digest(supplied, expected):
            return None
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != encoded:
            return None
        payload = json.loads(decoded)
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if not isinstance(payload, dict):
        return None
    if payload.get("v") != 1 or payload.get("aud") != TICKET_AUDIENCE:
        return None
    expires = payload.get("exp")
    nonce = payload.get("nonce")
    origin = payload.get("origin")
    if not isinstance(expires, int) or expires <= now or expires > now + TICKET_MAX_FUTURE_MS:
        return None
    if not isinstance(nonce, str) or len(nonce) < 20:
        return None
    if not isinstance(origin, str) or origin not in ALLOWED_ORIGINS:
        return None
    return payload


def require_authorization(authorization: str | None, origin: str | None) -> None:
    if authorization and secrets.compare_digest(authorization, f"Bearer {SHARED_SECRET}"):
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    ticket = _decode_ticket(authorization.removeprefix("Bearer "))
    if not ticket or origin != ticket.get("origin"):
        raise HTTPException(status_code=401, detail="unauthorized")
    nonce = str(ticket["nonce"])
    expires = int(ticket["exp"])
    now = int(time.time() * 1000)
    with _ticket_lock:
        for used_nonce, used_expiry in list(_used_tickets.items()):
            if used_expiry <= now:
                _used_tickets.pop(used_nonce, None)
        if nonce in _used_tickets:
            raise HTTPException(status_code=401, detail="ticket already used")
        _used_tickets[nonce] = expires


def whisper_model() -> WhisperModel:
    global _model
    with _model_lock:
        if _model is None:
            _model = WhisperModel(
                MODEL_NAME,
                device=MODEL_DEVICE,
                compute_type=MODEL_COMPUTE_TYPE,
                download_root=MODEL_DOWNLOAD_ROOT,
            )
        return _model


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # A recognizer that accepts traffic before loading Whisper turns the first
    # voice request into a cold-start timeout. Keep the container unready until
    # the model is present and warm; /models is a persistent Docker volume.
    whisper_model()
    yield


app = FastAPI(title="Jarvis local STT", version="1.1", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["authorization", "content-type"],
    expose_headers=["x-jarvis-stt-provider"],
    max_age=600,
)


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(MODEL_NAME),
    language: str | None = Form("en"),
    prompt: str | None = Form(None),
    authorization: str | None = Header(None),
    origin: str | None = Header(None),
) -> dict[str, object]:
    """OpenAI-compatible verbose JSON used by Jarvis's authenticated STT route."""
    require_authorization(authorization, origin)
    if model not in {"turbo", MODEL_NAME}:
        raise HTTPException(status_code=400, detail=f"this worker serves {MODEL_NAME}, not {model}")
    payload = await file.read(MAX_AUDIO_BYTES + 1)
    if len(payload) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio exceeds local STT size limit")
    if not payload:
        raise HTTPException(status_code=400, detail="audio is empty")

    suffix = Path(file.filename or "speech.webm").suffix or ".webm"
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            temp.write(payload)
            temp_path = temp.name
        segments, _info = whisper_model().transcribe(
            temp_path,
            language=language or None,
            beam_size=MODEL_BEAM_SIZE,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            hotwords=prompt or None,
        )
        rows = [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
                "avg_logprob": segment.avg_logprob,
                "no_speech_prob": segment.no_speech_prob,
            }
            for segment in segments
            if segment.text.strip()
        ]
        return {
            "text": " ".join(str(row["text"]) for row in rows).strip(),
            "segments": rows,
            "model": MODEL_NAME,
            "engine": "faster-whisper",
        }
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
