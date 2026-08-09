# Jarvis local speech-to-text

This is a self-hosted, authenticated `faster-whisper` worker. It defaults to
the open-source Whisper `turbo` model—the same Turbo-class model Jarvis used
through Groq—so it removes per-minute vendor transcription charges without
silently choosing a smaller model.

It uses the machine's CPU by default (`int8`). A CUDA-capable host can set
`STT_DEVICE=cuda` and an appropriate `STT_COMPUTE_TYPE` in a protected compose
override. The first start downloads the model into the named Docker volume;
later starts reuse it.

## Start on a machine Jarvis can reach

```bash
cd services/local-stt
export LOCAL_STT_SHARED_SECRET='a-long-random-value'
docker compose up --build -d
curl http://127.0.0.1:8080/healthz
```

For a self-hosted Jarvis app, set `LOCAL_STT_URL=http://127.0.0.1:8080`. For
the Vercel app, expose this worker over a private authenticated network and set
`LOCAL_STT_URL` to that private/reachable base URL. Store both
`LOCAL_STT_URL` and `LOCAL_STT_SHARED_SECRET` under the `local-stt` vault
service. Jarvis appends `/v1/audio/transcriptions` automatically.

The endpoint accepts standard multipart `file`, `model`, `language`, and
`prompt` fields and returns verbose JSON with segment confidence data. It never
contacts Groq or Google Cloud.
