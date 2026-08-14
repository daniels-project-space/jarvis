import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { NovitaPatchProposerAttestation } from "../lib/novita-patch-proposer-attestation";
import {
  derivedNovitaEndpointBearer,
  parseNovitaPatchProposal,
  requestNovitaPatchProposal,
} from "./novita-qwen-patch-proposer";

function runtimeConfig() {
  const withoutDigest = {
    endpointUrl: "https://qwen.endpoint.novita.ai/private-endpoint",
    lifecycle: {
      provider: "novita-serverless-v1",
      minWorkers: 0,
      maxWorkers: 1,
      idleTimeoutSeconds: 600,
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
  const configDigest = createHash("sha256").update(JSON.stringify(withoutDigest)).digest("hex");
  return { ...withoutDigest, configDigest };
}

function environment() {
  return { JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify(runtimeConfig()) };
}

function attestation(): NovitaPatchProposerAttestation {
  const config = runtimeConfig();
  const { endpointUrl, lifecycle, ...attestation } = config;
  void endpointUrl;
  void lifecycle;
  return attestation;
}

function sealedEndpointList() {
  const config = runtimeConfig();
  return Response.json({
    endpoints: [{
      id: config.endpointId,
      url: config.endpointUrl,
      image: { image: `registry.example/jarvis-qwen@${config.imageDigest}` },
      workerConfig: { minNum: 0, maxNum: "1", freeTimeout: 600 },
      healthy: { path: config.lifecycle.healthPath },
      state: { state: "running" },
      workers: [],
    }],
  });
}

function providerFetch(response: Response) {
  return vi.fn()
    .mockResolvedValueOnce(sealedEndpointList())
    .mockResolvedValueOnce(response);
}

describe("Novita Qwen patch proposer", () => {
  it("makes exactly one bounded, authenticated OpenAI-compatible proposal request", async () => {
    const fetchImpl = providerFetch(Response.json({
      model: attestation().modelId,
      choices: [{ message: { content: JSON.stringify({
        kind: "propose_patch",
        unifiedDiff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        evidence: ["Updates the named constant only."],
      }) } }],
    }));
    const getApiKey = vi.fn().mockResolvedValue("secret-not-in-result");

    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts so the constant is two.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey,
      environment: environment(),
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "proposed", proposal: { kind: "propose_patch" } });
    expect(getApiKey).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.novita.ai/gpu-instance/openapi/v1/endpoints");
    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe("https://qwen.endpoint.novita.ai/private-endpoint/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers.authorization).toBe(`Bearer ${derivedNovitaEndpointBearer("secret-not-in-result", attestation())}`);
    expect(init.headers.authorization).not.toContain("secret-not-in-result");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
      max_tokens: 800,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-not-in-result");
  });

  it("rejects a completion from a model other than the attested delegate", async () => {
    const fetchImpl = providerFetch(Response.json({
      model: "Qwen/Qwen2.5-Coder-7B-Instruct-GPTQ-Int4",
      choices: [{ message: { content: JSON.stringify({ kind: "no_change", reason: "No edit is needed." }) } }],
    }));

    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts so the constant is two.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey: vi.fn().mockResolvedValue("control-key"),
      environment: environment(),
      fetchImpl,
    });

    expect(result).toEqual({ status: "rejected", reason: "response_model_mismatch" });
  });

  it("fails closed before vault access when the runtime endpoint changes", async () => {
    const altered = runtimeConfig();
    const getApiKey = vi.fn();
    const fetchImpl = vi.fn();

    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey,
      environment: { JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify({ ...altered, endpointId: "endpoint_changed" }) },
      fetchImpl,
    });

    expect(result).toEqual({ status: "unavailable", reason: "attestation_mismatch" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before vault access when only the endpoint URL drifts", async () => {
    const altered = runtimeConfig();
    const getApiKey = vi.fn();
    const fetchImpl = vi.fn();
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey,
      environment: {
        JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify({
          ...altered,
          endpointUrl: "https://other.endpoint.novita.ai/private-endpoint",
        }),
      },
      fetchImpl,
    });
    expect(result).toEqual({ status: "unavailable", reason: "runtime_config_digest_mismatch" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before the custom model request when provider endpoint metadata drifts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      endpoints: [{
        id: attestation().endpointId,
        url: "https://qwen.endpoint.novita.ai/other-path",
        image: { image: `registry.example/jarvis-qwen@${attestation().imageDigest}` },
        workerConfig: { minNum: 0, maxNum: 1, freeTimeout: 600 },
        healthy: { path: "/healthz" },
        workers: [],
      }],
    }));
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey: vi.fn().mockResolvedValue("control-key"),
      environment: environment(),
      fetchImpl,
    });

    expect(result).toEqual({ status: "unavailable", reason: "lifecycle_endpoint_url_mismatch" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.novita.ai/gpu-instance/openapi/v1/endpoints");
  });

  it("rejects a patch that touches an unprovided or unsafe path", () => {
    const limits = attestation().requestLimits;
    expect(parseNovitaPatchProposal({
      kind: "propose_patch",
      unifiedDiff: "--- a/src/example.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n",
      evidence: [],
    }, ["src/example.ts"], limits)).toBeNull();
    expect(parseNovitaPatchProposal({
      kind: "propose_patch",
      unifiedDiff: "--- a/src/example.ts\n+++ b/src/../../secrets.ts\n@@ -1 +1 @@\n-a\n+b\n",
      evidence: [],
    }, ["src/example.ts"], limits)).toBeNull();
  });

  it("does not call a provider for unbounded source context", async () => {
    const fetchImpl = vi.fn();
    const getApiKey = vi.fn();
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "x".repeat(20_000) }],
      getApiKey,
      environment: environment(),
      fetchImpl,
    });
    expect(result).toEqual({ status: "skipped", reason: "source_context_out_of_bounds" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts prompt framing in the input cap before it reads the vault", async () => {
    const fetchImpl = vi.fn();
    const getApiKey = vi.fn();
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "x".repeat(11_900) }],
      getApiKey,
      environment: environment(),
      fetchImpl,
    });
    expect(result).toEqual({ status: "skipped", reason: "request_out_of_bounds" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized response without parsing it", async () => {
    const fetchImpl = providerFetch(new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "999999" },
    }));
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      getApiKey: vi.fn().mockResolvedValue("control-key"),
      environment: environment(),
      fetchImpl,
    });
    expect(result).toEqual({ status: "rejected", reason: "response_out_of_bounds" });
  });

  it("rejects source content that contains a credential pattern before vault access", async () => {
    const fetchImpl = vi.fn();
    const getApiKey = vi.fn();
    const result = await requestNovitaPatchProposal({
      attestation: attestation(),
      task: "Fix src/example.ts.",
      files: [{ path: "src/example.ts", content: "const key = 'nvapi-abcdefghijk';\n" }],
      getApiKey,
      environment: environment(),
      fetchImpl,
    });
    expect(result).toEqual({ status: "skipped", reason: "source_context_out_of_bounds" });
    expect(getApiKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
