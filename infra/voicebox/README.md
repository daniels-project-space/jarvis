# Jarvis Voicebox cloud image

This image turns the audited upstream Voicebox commit into Jarvis's private TTS service. It seeds the landing site's `Jarvis` demo clip as the deterministic `jarvis` cloned profile, applies Voicebox's built-in Robot effect settings, requires bearer authentication on every generation route, and loads Qwen 1.7B before the service becomes ready.

Runtime requirements:

- NVIDIA CUDA GPU with at least 8 GB VRAM (the upstream estimate is about 6 GB for Qwen 1.7B).
- One persistent network-volume mount at `/app/persist`; its `data` subdirectory holds profile/SQLite state and `models` holds the model cache.
- `VOICEBOX_TTS_TOKEN` set to a long random secret. The service must be exposed only through provider TLS.
- Health probe: `GET /health`; port `17493` by default.

Jarvis activation variables in Vercel:

```text
VOICEBOX_TTS_URL=https://<private-gateway-host>
VOICEBOX_PROFILE_ID=jarvis
VOICEBOX_TTS_TOKEN=<same bearer secret>
VOICEBOX_TTS_TIMEOUT_MS=5500
```

The Jarvis API then calls Voicebox first and streams its WAV response. If a spot worker is reclaimed or misses the configured latency budget, the existing free neural route handles that segment so Jarvis never becomes silent.

The container deliberately does not create GPU infrastructure. On Novita, use a persistent network volume and a spot RTX 3090/4090-class instance with automatic idle shutdown. Keeping it permanently warm creates continuous GPU charges; scale-to-zero/serverless avoids idle billing but has a multi-minute cold start, so activation is a cost/latency decision that must be made explicitly.
