FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SHERPA_MODEL_DIR=/models/zipformer-en

RUN useradd --create-home --uid 10001 jarvis \
  && mkdir -p /app /models \
  && chown -R jarvis:jarvis /app /models

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
USER jarvis

EXPOSE 8081
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081"]
