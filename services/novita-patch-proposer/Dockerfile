# The build must receive a digest-pinned vLLM image, for example:
# docker build --build-arg VLLM_BASE_IMAGE='vllm/vllm-openai@sha256:<verified-digest>' .
ARG VLLM_BASE_IMAGE
FROM ${VLLM_BASE_IMAGE}

ARG VLLM_BASE_IMAGE
RUN case "$VLLM_BASE_IMAGE" in *@sha256:*) ;; *) echo 'VLLM_BASE_IMAGE must be digest-pinned' >&2; exit 64;; esac

USER root
WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
  && (id -u jarvis >/dev/null 2>&1 || useradd --create-home --uid 10001 jarvis) \
  && mkdir -p /app /models \
  && chown -R jarvis:jarvis /app /models
COPY adapter ./adapter

USER jarvis
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    XDG_CACHE_HOME=/models

EXPOSE 8080
CMD ["python", "-m", "adapter.app"]
