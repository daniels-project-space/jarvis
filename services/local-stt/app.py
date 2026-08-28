from __future__ import annotations

import os
import secrets
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("STT_MODEL", "turbo")
MODEL_DEVICE = os.environ.get("STT_DEVICE", "auto")
MODEL_COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")
MODEL_DOWNLOAD_ROOT = os.environ.get("STT_MODEL_DIR", "/models")
SHARED_SECRET = os.environ.get("STT_SHARED_SECRET", "")
MAX_AUDIO_BYTES = int(os.environ.get("STT_MAX_AUDIO_BYTES", str(20 * 1024 * 1024)))

if not SHARED_SECRET:
    raise RuntimeError("STT_SHARED_SECRET is required; refusing to expose unauthenticated speech recognition")

_model: WhisperModel | None = None
_model_lock = Lock()


def require_authorization(authorization: str | None) -> None:
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {SHARED_SECRET}"):
        raise HTTPException(status_code=401, detail="unauthorized")


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


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {"ok": True, "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form("turbo"),
    language: str | None = Form("en"),
    prompt: str | None = Form(None),
    authorization: str | None = Header(None),
) -> dict[str, object]:
    """OpenAI-compatible verbose JSON used by Jarvis's authenticated STT route."""
    require_authorization(authorization)
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
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
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
