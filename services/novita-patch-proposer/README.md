# Sealed Novita patch-proposer adapter

This is the worker image for the one intentionally narrow open-weight delegate.
It is not a general OpenAI proxy: it accepts only the exact one-turn,
JSON-object patch-proposal shape emitted by `src/trigger/novita-qwen-patch-proposer.ts`.

At startup it verifies the existing `JARVIS_NOVITA_QWEN_ATTESTATION` using the
same canonical digest used by Jarvis. It requires all of the following:

- `adapterId=novita-qwen-patch-proposer-v1`, Qwen GPTQ-Int4 model and immutable revision;
- the attested scale-to-zero policy (`minWorkers=0`, `maxWorkers=1`);
- `JARVIS_NOVITA_ADAPTER_IMAGE_DIGEST` exactly matching the attested final adapter image digest;
- `JARVIS_NOVITA_ENDPOINT_BEARER`, the *derived*, versioned
  `jnpb1.<endpoint-id>.<base64url-hmac>` bearer from
  `derivedNovitaEndpointBearer` — raw Novita account or billing keys are not
  a valid wire format.

The adapter starts vLLM only on `127.0.0.1:8001`, with the attested model ID,
revision, GPTQ mode, one concurrent sequence, and request logging disabled.
Its subprocess receives a fixed minimal environment only; the endpoint bearer,
attestation, provider key, and every token/secret are deliberately absent.
It exposes only port `8080`; `/healthz` reports ready only after the loopback
model server is healthy. Requests with tools, function calls, shell commands,
credential-shaped content, alternate models, streaming, unsupported fields, or
unprovided diff paths are rejected. Responses are parsed and rebuilt into a
single bounded OpenAI chat-completion object, so upstream model extras cannot
become capability channels.

## Build and endpoint configuration

Build from a reviewed digest-pinned vLLM base; the Dockerfile intentionally
fails for a mutable tag:

```sh
docker build services/novita-patch-proposer \
  --build-arg VLLM_BASE_IMAGE='vllm/vllm-openai@sha256:<reviewed-base-digest>' \
  --tag registry.example/jarvis-novita-patch-proposer:<revision>
```

After pushing the final image by digest, prepare the existing attestation with
that final digest and configure the Novita serverless endpoint manually:

- HTTP port `8080`, health path `/healthz`, and startup command exactly
  `python -m adapter.app`;
- `minNum: 0`, `maxNum: 1`, `freeTimeout` equal to the attestation;
- `gpuNum: 1` and `maxConcurrent: 1`;
- final adapter image referenced by `@sha256:...` and the same digest in the
  attestation and `JARVIS_NOVITA_ADAPTER_IMAGE_DIGEST`;
- the full non-secret attestation in `JARVIS_NOVITA_QWEN_ATTESTATION`;
- the derived endpoint bearer only in `JARVIS_NOVITA_ENDPOINT_BEARER`.

Do not put `NOVITA_API_KEY`, any vault credential, a shell command, or a general
model API key in this image or endpoint environment. Existing Jarvis lifecycle
verification will refuse any endpoint whose final image digest, URL, startup
command, port, health path, worker bounds, concurrency, GPU count, or idle
timeout drift from that attestation.

Run the policy tests without a GPU or container build:

```sh
python3 -m unittest discover -s services/novita-patch-proposer/tests -v
```
