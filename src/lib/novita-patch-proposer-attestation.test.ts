import { describe, expect, it } from "vitest";

import {
  configuredNovitaPatchProposer,
  novitaPatchProposerForWorkOrder,
  resolveNovitaPatchProposerAttestation,
} from "./novita-patch-proposer-attestation";

const attestation = {
  adapterId: "novita-qwen-patch-proposer-v1",
  configDigest: "a".repeat(64),
  endpointId: "endpoint_123456",
  modelId: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
  modelRevision: "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
  imageDigest: "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
  quantization: "gptq-int4",
  api: "openai-chat-completions",
  requestLimits: { maxInputBytes: 12_000, maxOutputTokens: 800, maxTurns: 1, timeoutMs: 30_000 },
} as const;

describe("Novita patch-proposer attestation", () => {
  it("keeps endpoint URLs out of durable attestations", () => {
    expect(resolveNovitaPatchProposerAttestation(attestation)).toEqual(attestation);
    expect(resolveNovitaPatchProposerAttestation({ ...attestation, endpointUrl: "https://example.test" })).toBeNull();
  });

  it("admits only a strict HTTPS runtime configuration", () => {
    const runtime = configuredNovitaPatchProposer({
      JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify({ endpointUrl: "https://example.test/qwen", ...attestation }),
    });
    expect(runtime).toMatchObject({ endpointUrl: "https://example.test/qwen", attestation });
    expect(configuredNovitaPatchProposer({
      JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify({ endpointUrl: "http://example.test", ...attestation }),
    })).toBeNull();
  });

  it("selects the delegate only for bounded low-risk owned coding work", () => {
    const previous = process.env.JARVIS_NOVITA_QWEN_ATTESTATION;
    process.env.JARVIS_NOVITA_QWEN_ATTESTATION = JSON.stringify({ endpointUrl: "https://example.test/qwen", ...attestation });
    try {
      expect(novitaPatchProposerForWorkOrder({
        task: "Fix src/lib/example.ts so it handles the null result.",
        modelTier: "luna",
        readonly: false,
        repository: "daniels-project-space/jarvis",
        sourceProvider: "github",
        risk: "low",
        approvalRequired: false,
        mcpScope: [],
      })).toEqual(attestation);
      expect(novitaPatchProposerForWorkOrder({
        task: "Deploy a production fix in src/lib/example.ts.",
        modelTier: "luna",
        readonly: false,
        repository: "daniels-project-space/jarvis",
        sourceProvider: "github",
        risk: "consequential",
        approvalRequired: true,
        mcpScope: [],
      })).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.JARVIS_NOVITA_QWEN_ATTESTATION;
      else process.env.JARVIS_NOVITA_QWEN_ATTESTATION = previous;
    }
  });
});
