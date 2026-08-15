import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { configuredNovitaPatchProposer } from "./novita-patch-proposer-attestation";
import { verifyNovitaServerlessLifecycle } from "./novita-serverless-lifecycle";

function config() {
  const raw = {
    endpointUrl: "https://qwen.endpoint.novita.ai/private-endpoint",
    lifecycle: {
      provider: "novita-serverless-v1",
      minWorkers: 0,
      maxWorkers: 1,
      idleTimeoutSeconds: 600,
      port: 8080,
      maxConcurrent: 1,
      gpuNum: 1,
      startupCommand: "python -m adapter.app",
      healthPath: "/healthz",
    },
    adapterId: "novita-qwen-patch-proposer-v1",
    endpointId: "endpoint_123456",
    modelId: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
    modelRevision: "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
    imageDigest: "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
    quantization: "gptq-int4",
    api: "openai-chat-completions",
    endpointAuth: "hmac-sha256-v1",
    requestLimits: { maxInputBytes: 12_000, maxOutputTokens: 800, maxTurns: 1, timeoutMs: 30_000 },
  } as const;
  const configDigest = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const parsed = configuredNovitaPatchProposer({ JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify({ ...raw, configDigest }) });
  if (!parsed) throw new Error("test configuration should parse");
  return parsed;
}

function endpoint(overrides: Record<string, unknown> = {}) {
  const runtime = config();
  return {
    id: runtime.attestation.endpointId,
    url: runtime.endpointUrl,
    image: {
      image: `registry.example/jarvis-qwen@${runtime.attestation.imageDigest}`,
      command: runtime.lifecycle.startupCommand,
    },
    ports: [{ port: String(runtime.lifecycle.port) }],
    workerConfig: {
      minNum: "0",
      maxNum: 1,
      freeTimeout: "600",
      maxConcurrent: "1",
      gpuNum: 1,
    },
    healthy: { path: runtime.lifecycle.healthPath },
    state: { state: "running" },
    workers: [],
    ...overrides,
  };
}

describe("Novita serverless lifecycle verifier", () => {
  it("accepts only the exact sealed endpoint while it is correctly idle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint()] }));
    const result = await verifyNovitaServerlessLifecycle({ config: config(), apiKey: "control-key", fetchImpl });

    expect(result).toEqual({ status: "idle" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.novita.ai/gpu-instance/openapi/v1/endpoints");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.headers.authorization).toBe("Bearer control-key");
  });

  it("fails closed when the provider returns the endpoint ID at a different custom path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ url: "https://qwen.endpoint.novita.ai/other-path" })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl }))
      .resolves.toEqual({ status: "unavailable", reason: "endpoint_url_mismatch" });
  });

  it("fails closed on image or scale-to-zero lifecycle drift", async () => {
    const imageDrift = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ image: { image: "registry.example/jarvis-qwen:latest" } })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: imageDrift }))
      .resolves.toEqual({ status: "unavailable", reason: "image_digest_mismatch" });

    const scaleDrift = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ workerConfig: { minNum: 1, maxNum: 2, freeTimeout: 900 } })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: scaleDrift }))
      .resolves.toEqual({ status: "unavailable", reason: "lifecycle_config_mismatch" });
  });

  it("fails closed before model egress when startup command, port, or worker capacity drifts", async () => {
    const commandDrift = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({
      image: { image: `registry.example/jarvis-qwen@${config().attestation.imageDigest}`, command: "python -m other.app" },
    })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: commandDrift }))
      .resolves.toEqual({ status: "unavailable", reason: "lifecycle_config_mismatch" });

    const portDrift = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ ports: [{ port: "9090" }] })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: portDrift }))
      .resolves.toEqual({ status: "unavailable", reason: "lifecycle_config_mismatch" });

    const capacityDrift = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({
      workerConfig: { minNum: 0, maxNum: 1, freeTimeout: 600, maxConcurrent: 2, gpuNum: 2 },
    })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: capacityDrift }))
      .resolves.toEqual({ status: "unavailable", reason: "lifecycle_config_mismatch" });
  });

  it("accepts a healthy active worker but rejects unhealthy workers", async () => {
    const active = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ workers: [{ id: "worker_1", healthy: true, state: { state: "running" } }] })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: active }))
      .resolves.toEqual({ status: "ready" });

    const unhealthy = vi.fn().mockResolvedValue(Response.json({ endpoints: [endpoint({ workers: [{ id: "worker_1", healthy: false, state: { state: "running" } }] })] }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl: unhealthy }))
      .resolves.toEqual({ status: "unavailable", reason: "endpoint_unhealthy" });
  });

  it("bounds malformed provider output without trying a custom endpoint health URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "1000001" },
    }));
    await expect(verifyNovitaServerlessLifecycle({ config: config(), apiKey: "key", fetchImpl }))
      .resolves.toEqual({ status: "unavailable", reason: "provider_response_too_large" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.novita.ai/gpu-instance/openapi/v1/endpoints",
    ]);
  });
});
