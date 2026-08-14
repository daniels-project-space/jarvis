import { describe, expect, it } from "vitest";

import { configuredNovitaPatchProposer } from "./novita-patch-proposer-attestation";
import {
  novitaPatchProposerConfigurationReadiness,
  novitaPatchProposerRuntimeConfigDigest,
} from "./novita-patch-proposer-runtime-config.server";

const baseAttestation = {
  adapterId: "novita-qwen-patch-proposer-v1",
  configDigest: "a".repeat(64),
  endpointId: "endpoint_123456",
  modelId: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
  modelRevision: "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
  imageDigest: "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
  quantization: "gptq-int4" as const,
  api: "openai-chat-completions" as const,
  endpointAuth: "hmac-sha256-v1" as const,
  requestLimits: { maxInputBytes: 12_000, maxOutputTokens: 800, maxTurns: 1 as const, timeoutMs: 30_000 },
};

const lifecycle = {
  provider: "novita-serverless-v1" as const,
  minWorkers: 0 as const,
  maxWorkers: 1 as const,
  idleTimeoutSeconds: 600,
  healthPath: "/healthz",
};

function matchingEnvironment() {
  const raw = { endpointUrl: "https://qwen.endpoint.novita.ai/qwen", lifecycle, ...baseAttestation };
  const parsed = configuredNovitaPatchProposer({ JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify(raw) });
  if (!parsed) throw new Error("test Novita configuration should parse");
  raw.configDigest = novitaPatchProposerRuntimeConfigDigest(parsed);
  return { JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify(raw) };
}

describe("Novita patch-proposer configuration readiness", () => {
  it("distinguishes absent and malformed attestations without returning configuration data", () => {
    expect(novitaPatchProposerConfigurationReadiness({})).toEqual({
      configured: false,
      code: "attestation_not_configured",
    });
    expect(novitaPatchProposerConfigurationReadiness({ JARVIS_NOVITA_QWEN_ATTESTATION: "not-json" })).toEqual({
      configured: false,
      code: "attestation_invalid",
    });
  });

  it("requires the endpoint configuration to match its immutable digest", () => {
    const environment = matchingEnvironment();
    expect(novitaPatchProposerConfigurationReadiness(environment)).toEqual({
      configured: true,
      code: "attestation_ready",
    });

    const raw = JSON.parse(environment.JARVIS_NOVITA_QWEN_ATTESTATION) as Record<string, unknown>;
    raw.endpointUrl = "https://qwen.endpoint.novita.ai/another-path";
    expect(novitaPatchProposerConfigurationReadiness({
      JARVIS_NOVITA_QWEN_ATTESTATION: JSON.stringify(raw),
    })).toEqual({
      configured: false,
      code: "runtime_config_digest_mismatch",
    });
  });
});
