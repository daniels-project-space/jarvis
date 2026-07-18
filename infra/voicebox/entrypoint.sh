#!/bin/sh
set -eu

: "${VOICEBOX_TTS_TOKEN:?VOICEBOX_TTS_TOKEN is required}"

mkdir -p "${VOICEBOX_DATA_DIR}" "${VOICEBOX_MODELS_DIR}"
chown voicebox:voicebox "$(dirname "${VOICEBOX_DATA_DIR}")" "${VOICEBOX_DATA_DIR}" "${VOICEBOX_MODELS_DIR}"

gosu voicebox python /app/seed_profile.py
cd /app/source
exec gosu voicebox uvicorn cloud_entry:app --app-dir /app --host 0.0.0.0 --port "${PORT}"
