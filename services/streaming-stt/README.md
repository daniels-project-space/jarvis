# Jarvis self-hosted streaming speech

This is the zero-per-minute-cost path for near-instant voice text: an open-source
Sherpa-ONNX streaming Zipformer recognizer on a small CPU host. It sends partial
text while Daniel is speaking; only the final text can be used as a Jarvis turn.
The existing browser speech preview and authenticated `faster-whisper` recording
path remain fallbacks.

## Prepare a CPU host

Download the published CPU model once (no paid API or GPU is needed):

```bash
cd services/streaming-stt
./download-model.sh ./models
```

The compose file reads that local `models/zipformer-en` directory, then starts
the service with a long random ticket secret:

```bash
export STREAMING_STT_TICKET_SECRET='a-long-random-value'
docker compose up --build -d
```

Keep port 8081 private. Put an HTTPS/WSS reverse proxy in front of it and set
`STREAMING_STT_PUBLIC_URL` to that `wss://…/v1/stream` address plus the matching
`STREAMING_STT_TICKET_SECRET` in the `streaming-stt` vault service. Jarvis mints
a one-use, 60-second, origin-bound ticket; it never exposes the host secret.

Only after the WSS host has passed its health check, set
`NEXT_PUBLIC_SELF_HOSTED_STREAMING_STT=1` for the new Jarvis web build. This is
an explicit feature gate: existing deployments make no stream-ticket requests.

The browser feature fails closed when either setting is absent. It does not add a
paid transcription provider or provision a GPU.

After every service update, validate the end-of-utterance protocol as well as
`/healthz`: an authenticated stream must emit `ready`, accept PCM16 audio, emit a
`final` message after `{ "type": "end" }`, and close with code 1000. Health alone
does not prove that the recognizer can flush its final encoder chunk.
