# Jarvis self-hosted streaming TTS

This is the optional private reply-voice lane. It runs the open-weight Kokoro
model on the same kind of small host as streaming STT and streams MP3 sentence
audio, so the existing browser player can start before the entire reply is
synthesized.

It is deliberately not enabled by this directory. Jarvis enables it only when
all three server-side settings are present:

- `JARVIS_SELF_HOSTED_TTS=1`
- `SELF_HOSTED_TTS_URL` — public `https://` reverse-proxy address (or
  `http://localhost` for local development)
- `SELF_HOSTED_TTS_API_KEY` — the same long random bearer value as the host's
  `KOKORO_API_KEY`

Store the URL and key in the `streaming-tts` Project Hub vault service. The
browser never receives the key. If the opt-in is on but the service, credentials
or audio response are invalid, Jarvis returns an error; it never falls back to
Edge or another cloud speech provider.

## Host setup

1. Choose and record a reviewed immutable image digest for the Kokoro server.
   Set it as `KOKORO_SERVER_IMAGE`; do not use a floating `latest` tag.
2. Set `SELF_HOSTED_TTS_API_KEY` in the host environment to a long random
   value, then start `docker compose up -d` from this directory.
3. Put an HTTPS reverse proxy in front of `127.0.0.1:8082`. Do not expose the
   raw port to the Internet.
4. Before enabling Jarvis, prove the local `/docs` readiness endpoint responds
   and make one authenticated
   `POST /v1/audio/speech` with `response_format: "mp3"` and
   `stream_format: "audio"`. Retain only status/latency evidence, never the
   bearer value or speech text.
5. Add the two `streaming-tts` vault settings, deploy Jarvis with the explicit
   opt-in, then verify `GET /api/tts` reports `self-hosted-kokoro`.

Kokoro's model is Apache-2.0; the selected Docker server is an independent
MIT-licensed wrapper. Review and pin the selected image before it is allowed on
the host.
