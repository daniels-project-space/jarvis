import { describe, expect, it } from "vitest";
import { cloudProviderAdmissionReadiness } from "./cloud-provider-admission";

const NOW = 1_800_000_000_000;
const DIGEST = "a".repeat(64);
const REQUIRED_CAPABILITIES = [
  "credentiallessArchive",
  "privateIngress",
  "networkDenyByDefault",
  "emptyEnvironment",
  "boundedResources",
  "boundedTtl",
  "exactCommandCancellation",
  "portableCheckpointReplay",
];

function environment(overrides: Record<string, string | undefined> = {}) {
  const receipt = {
    schemaVersion: 1,
    provider: "sandbox0",
    deploymentId: "20260806.9",
    sdk: { package: "sandbox0", version: "0.9.3" },
    template: { identity: "node22-codex-0.144.5", digest: DIGEST },
    runtime: { identity: "node-22:codex-0.144.5", digest: "b".repeat(64) },
    exercisedCapabilities: REQUIRED_CAPABILITIES,
    observed: {
      cpu: 2,
      memoryMb: 4_096,
      ttlMs: 44 * 60_000,
      quota: { cpu: true, memory: true, activeSandboxes: true },
      privateIngress: true,
      emptyEnvironment: true,
      networkDeny: true,
      exactCancellation: true,
      lifecycle: {
        create: true,
        exec: true,
        checkpoint: true,
        terminate: true,
        recreate: true,
        identityChanged: true,
      },
    },
    probeTime: NOW - 60_000,
    expiresAt: NOW + 60 * 60_000,
    runId: "provider-probe-test",
    nonce: "test-provider-probe-nonce",
  };
  return {
    JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE: "node22-codex-0.144.5",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: DIGEST,
    JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "20260806.9",
    JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify({
      keyId: "current",
      receipt,
      signature: "c".repeat(64),
    }),
    ...overrides,
  };
}

function withReceipt(
  transform: (receipt: {
    provider: string;
    deploymentId: string;
    template: { identity: string; digest: string };
    probeTime: number;
    expiresAt: number;
    [key: string]: unknown;
  }) => void,
  overrides: Record<string, string | undefined> = {},
) {
  const env = environment(overrides);
  const envelope = JSON.parse(String(env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT)) as {
    receipt: {
      provider: string;
      deploymentId: string;
      template: { identity: string; digest: string };
      probeTime: number;
      expiresAt: number;
      [key: string]: unknown;
    };
  };
  transform(envelope.receipt);
  return { ...env, JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify(envelope) };
}

describe("cloud provider Goal Mode admission readiness", () => {
  it("accepts a fresh receipt matching the non-secret provider deployment tuple", () => {
    expect(cloudProviderAdmissionReadiness(environment(), NOW)).toEqual({ ready: true });
  });

  it.each([
    "JARVIS_CLOUD_WORKSPACE_TEMPLATE",
    "JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST",
    "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID",
  ])("rejects missing %s configuration", (key) => {
    expect(cloudProviderAdmissionReadiness(environment({ [key]: undefined }), NOW)).toEqual({
      ready: false,
      code: "missing_configuration",
    });
  });

  it("recovers a missing provider selector from the bound receipt", () => {
    expect(cloudProviderAdmissionReadiness(environment({
      JARVIS_CLOUD_WORKSPACE_PROVIDER: undefined,
    }), NOW)).toEqual({ ready: true });
  });

  it("distinguishes a missing receipt from malformed evidence", () => {
    expect(cloudProviderAdmissionReadiness(environment({
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: undefined,
    }), NOW)).toEqual({ ready: false, code: "missing_receipt" });
    expect(cloudProviderAdmissionReadiness(environment({
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "{not-json",
    }), NOW)).toEqual({ ready: false, code: "malformed_receipt" });
    expect(cloudProviderAdmissionReadiness(environment({
      JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: "not-a-digest",
    }), NOW)).toEqual({ ready: false, code: "malformed_configuration" });
  });

  it.each([
    withReceipt((receipt) => { receipt.expiresAt = NOW; }),
    withReceipt((receipt) => { receipt.probeTime = NOW + 60_001; }),
    withReceipt((receipt) => { receipt.expiresAt = receipt.probeTime + 24 * 60 * 60_000 + 1; }),
  ])("rejects stale or implausibly dated receipts", (env) => {
    expect(cloudProviderAdmissionReadiness(env, NOW)).toEqual({ ready: false, code: "stale_receipt" });
  });

  it.each([
    ["provider", "vercel"],
    ["deploymentId", "20260806.10"],
    ["template.identity", "different-template"],
    ["template.digest", "d".repeat(64)],
  ])("rejects a receipt with mismatched %s", (field, value) => {
    const env = withReceipt((receipt) => {
      if (field === "template.identity") receipt.template.identity = value;
      else if (field === "template.digest") receipt.template.digest = value;
      else receipt[field] = value;
    });
    expect(cloudProviderAdmissionReadiness(env, NOW)).toEqual({
      ready: false,
      code: "mismatched_receipt",
    });
  });

  it("does not pretend to verify the worker-only signature or capability authority", () => {
    const env = environment();
    const envelope = JSON.parse(String(env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT));
    envelope.signature = "d".repeat(64);
    envelope.receipt.exercisedCapabilities = [];
    envelope.receipt.observed = {};
    env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT = JSON.stringify(envelope);
    expect(cloudProviderAdmissionReadiness(env, NOW)).toEqual({ ready: true });
  });
});
