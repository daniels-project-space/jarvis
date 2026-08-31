# Jarvis local speech-to-text

This is a self-hosted, authenticated `faster-whisper` worker. It defaults to
the English Whisper `small.en` model with a bounded beam for interactive CPU
latency. The vocabulary prompt and authoritative recorded pass retain
materially better command accuracy than the tiny streaming model while
removing per-minute vendor transcription charges. Set `STT_MODEL=turbo` and
`STT_BEAM_SIZE=5` on a GPU host when maximum transcription quality matters
more than live response time.

It uses the machine's CPU by default (`int8`). A CUDA-capable host can set
`STT_DEVICE=cuda` and an appropriate `STT_COMPUTE_TYPE` in a protected compose
override. Startup eagerly loads the model before the health endpoint becomes
available, so the first real voice turn is not a model-download or model-load
timeout. The model lives in the named Docker volume and is reused on later
starts.

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

The production host installs `infra/systemd/jarvis-local-stt.service` and
`infra/nginx/jarvis-speech.conf`. The same root-only secret is supplied to the
container and to the Jarvis server environment; the public HTTPS endpoint is
therefore transport-reachable but never anonymously usable. The streaming
Zipformer remains a low-latency partial recognizer. Final commands are
authoritatively transcribed by this Faster-Whisper worker.

The endpoint accepts standard multipart `file`, `model`, `language`, and
`prompt` fields and returns verbose JSON with segment confidence data. It never
contacts Groq or Google Cloud.
