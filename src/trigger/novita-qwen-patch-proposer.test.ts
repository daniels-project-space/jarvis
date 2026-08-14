import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { NovitaPatchProposerAttestation } from "../lib/novita-patch-proposer-attestation";
import { parseNovitaPatchProposal, requestNovitaPatchProposal } from "./novita-qwen-patch-proposer";

function runtimeConfig() {
  const withoutDigest = {
    endpointUrl: "https://qwen.endpoint.novita.ai/private-endpoint",
    adapterId: "novita-qwen-patch-proposer-v1",
    endpointId: "endpoint_123456",
    modelId: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
    modelRevision: "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
    imageDigest: "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
    quantization: "gptq-int4",
    api: "openai-chat-completions",
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
  const { endpointUrl, ...attestation } = config;
  void endpointUrl;
  return attestation;
}

describe("Novita Qwen patch proposer", () => {
  it("makes exactly one bounded, authenticated OpenAI-compatible proposal request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://qwen.endpoint.novita.ai/private-endpoint/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers.authorization).toBe("Bearer secret-not-in-result");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
      max_tokens: 800,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-not-in-result");
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
});
