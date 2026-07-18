# syntax=docker/dockerfile:1.7
FROM python:3.11-slim

ARG VOICEBOX_COMMIT=f2cf2a729d733acd7c759d85c6ace2d602f50d6e

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone https://github.com/jamiepine/voicebox.git /app/source \
  && cd /app/source \
  && git checkout "$VOICEBOX_COMMIT" \
  && rm -rf .git

# Install CUDA-enabled PyTorch before Voicebox. The remaining requirements see
# a satisfying torch version and do not replace it with a CPU-only wheel.
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cu128 \
    torch==2.8.0 torchaudio==2.8.0 \
  && pip install --no-cache-dir -r /app/source/backend/requirements.txt \
  && pip install --no-cache-dir qwen-tts==0.1.1 \
  && pip install --no-cache-dir --no-deps chatterbox-tts hume-tada

# The landing demo is the only upstream Jarvis profile artifact. Pin it to the
# same audited commit instead of following a mutable branch at container boot.
RUN curl --fail --location --retry 3 \
  "https://raw.githubusercontent.com/jamiepine/voicebox/${VOICEBOX_COMMIT}/landing/public/audio/jarvis.webm" \
  --output /app/jarvis.webm

COPY cloud_entry.py seed_profile.py entrypoint.sh /app/
RUN chmod 0755 /app/entrypoint.sh \
  && useradd --create-home --shell /usr/sbin/nologin voicebox \
  && mkdir -p /app/persist/data /app/persist/models \
  && chown -R voicebox:voicebox /app/persist

ENV PYTHONPATH=/app/source \
    VOICEBOX_DATA_DIR=/app/persist/data \
    VOICEBOX_MODELS_DIR=/app/persist/models \
    PORT=17493 \
    PYTHONUNBUFFERED=1

EXPOSE 17493
VOLUME ["/app/persist"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=600s --retries=3 \
  CMD curl --fail "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
