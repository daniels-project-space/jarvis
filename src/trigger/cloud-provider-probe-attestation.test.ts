import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_PROVIDER_PROBE_MAX_AGE_MS,
  canonicalProviderProbeJson,
  configuredCloudProviderProbeBinding,
  createCloudProviderProbeKeyring,
  type CloudProviderProbeEnvelope,
  type CloudProviderProbeReceipt,
} from "./cloud-provider-probe-attestation";
import { DEFAULT_WORKSPACE_LIMITS, REQUIRED_CLOUD_WORKSPACE_CAPABILITIES } from "./cloud-workspace";
import { configuredCloudWorkspaceProvider } from "./cloud-workspace-providers";
import { prepareCloudWorkspaceExecution } from "./cloud-workspace-controller";

const NOW = Date.now();
const SECRET = "controller-provider-probe-secret-32-bytes-minimum";
const DIGEST = "a".repeat(64);

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE: "template-immutable-v7",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: DIGEST,
    JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "trigger-deploy-2026-07-21-a",
    JARVIS_CLOUD_PROVIDER_PROBE_KEYRING: JSON.stringify({
      current: { keyId: "current", secret: SECRET }, previous: [],
    }),
    SANDBOX0_TOKEN: "synthetic-test-token",
  };
}

function receipt(env = baseEnvironment(), overrides: Partial<CloudProviderProbeReceipt> = {}): CloudProviderProbeReceipt {
  const binding = configuredCloudProviderProbeBinding(env);
  return {
    schemaVersion: 1,
    ...binding,
    exercisedCapabilities: [...REQUIRED_CLOUD_WORKSPACE_CAPABILITIES],
    observed: {
      cpu: DEFAULT_WORKSPACE_LIMITS.cpu,
      memoryMb: DEFAULT_WORKSPACE_LIMITS.memoryMb,
      ttlMs: DEFAULT_WORKSPACE_LIMITS.ttlMs,
      quota: { cpu: true, memory: true, activeSandboxes: true },
      privateIngress: true,
      emptyEnvironment: true,
      networkDeny: true,
      exactCancellation: true,
      lifecycle: { create: true, exec: true, checkpoint: true, terminate: true, recreate: true, identityChanged: true },
    },
    probeTime: NOW,
    expiresAt: NOW + CLOUD_PROVIDER_PROBE_MAX_AGE_MS,
    runId: "provider-probe-fixture-1",
    nonce: "fixture_nonce_1234567890",
    ...overrides,
  };
}

function signedEnvironment(env = baseEnvironment(), value = receipt(env)): NodeJS.ProcessEnv {
  const envelope = createCloudProviderProbeKeyring({ keyId: "current", secret: SECRET }).issue(value);
  return { ...env, JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify(envelope) };
}

describe("deployment-bound cloud provider probe authority", () => {
  it("keeps SANDBOX0_TOKEN alone blocked before adapter construction, hydration, or model execution", async () => {
    const env = baseEnvironment();
    delete env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT;
    expect(() => configuredCloudWorkspaceProvider(env)).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked", provider: "sandbox0",
    }));
    const hydrate = vi.fn();
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => configuredCloudWorkspaceProvider(env),
      hydrateArchive: hydrate,
      attemptKey: "blocked:1", template: env.JARVIS_CLOUD_WORKSPACE_TEMPLATE!,
      runtime: "node-22:codex-0.144.5", lockfileDigest: "0".repeat(64),
    })).rejects.toMatchObject({ code: "provider_probe_attestation_failed", disposition: "blocked" });
    expect(hydrate).not.toHaveBeenCalled();
    const source = readFileSync(join(process.cwd(), "src/trigger/cloud-workspace-providers.ts"), "utf8");
    const configured = source.slice(source.indexOf("export function configuredCloudWorkspaceProvider("), source.indexOf("/** Live-probe authority"));
    expect(configured.indexOf("assertCloudProviderExecutionReady(env)")).toBeLessThan(configured.indexOf("configuredProviderAdapter(env)"));
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    expect(runner.lastIndexOf("cloudProvider = configuredCloudWorkspaceProvider(process.env)")).toBeLessThan(runner.indexOf("await processJob(job, cloudProvider)"));
  });

  it("opens execution only for a fresh signed exact provider/template/SDK/deployment tuple", () => {
    const env = signedEnvironment();
    expect(configuredCloudWorkspaceProvider(env).name).toBe("sandbox0");
    for (const changed of [
      { JARVIS_CLOUD_WORKSPACE_PROVIDER: "e2b", E2B_API_KEY: "test", SANDBOX0_TOKEN: undefined },
      { JARVIS_CLOUD_WORKSPACE_TEMPLATE: "other-template" },
      { JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: "b".repeat(64) },
      { JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "other-deployment" },
    ]) {
      expect(() => configuredCloudWorkspaceProvider({ ...env, ...changed })).toThrow(expect.objectContaining({
        code: "provider_probe_attestation_failed", disposition: "blocked",
      }));
    }
  });

  it.each(["malformed", "stale", "partial", "tampered", "wrong sdk", "wrong provider", "conflicting key ids"])(
    "rejects %s synthetic receipts",
    (kind) => {
      const env = baseEnvironment();
      let candidate: NodeJS.ProcessEnv;
      if (kind === "malformed") {
        candidate = { ...env, JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "{}" };
      } else if (kind === "stale") {
        candidate = signedEnvironment(env, receipt(env, { probeTime: NOW - CLOUD_PROVIDER_PROBE_MAX_AGE_MS - 1, expiresAt: NOW - 1 }));
      } else if (kind === "partial") {
        const partial = receipt(env, { exercisedCapabilities: REQUIRED_CLOUD_WORKSPACE_CAPABILITIES.slice(0, -1) });
        expect(() => createCloudProviderProbeKeyring({ keyId: "current", secret: SECRET }).issue(partial)).toThrow(/partial/);
        candidate = { ...env, JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify({
          keyId: "current",
          receipt: partial,
          signature: createHmac("sha256", SECRET).update(canonicalProviderProbeJson(partial)).digest("hex"),
        }) };
      } else if (kind === "wrong sdk") {
        candidate = signedEnvironment(env, receipt(env, { sdk: { package: "sandbox0", version: "0.9.2" } }));
      } else if (kind === "wrong provider") {
        candidate = signedEnvironment(env, receipt(env, { provider: "e2b" }));
      } else if (kind === "conflicting key ids") {
        const valid = signedEnvironment(env);
        candidate = { ...valid, JARVIS_CLOUD_PROVIDER_PROBE_KEYRING: JSON.stringify({
          current: { keyId: "current", secret: SECRET },
          previous: [{ keyId: "current", secret: "previous-controller-provider-probe-secret" }],
        }) };
      } else {
        const valid = signedEnvironment(env);
        const envelope = JSON.parse(valid.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT!) as CloudProviderProbeEnvelope;
        const first = envelope.signature[0] === "0" ? "1" : "0";
        candidate = { ...valid, JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify({ ...envelope, signature: `${first}${envelope.signature.slice(1)}` }) };
      }
      expect(() => configuredCloudWorkspaceProvider(candidate)).toThrow(expect.objectContaining({
        code: "provider_probe_attestation_failed", disposition: "blocked",
      }));
    },
  );

  it("keeps cleanup authority narrowly available without an execution receipt", async () => {
    const env = baseEnvironment();
    delete env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT;
    const cleanup = configuredCloudWorkspaceProvider(env, false);
    expect(cleanup.name).toBe("sandbox0");
    await expect(cleanup.createWorkspace({
      attemptKey: "forbidden", template: "forbidden", runtime: "forbidden",
      lockfileDigest: "0".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    })).rejects.toMatchObject({ code: "provider_probe_attestation_failed", disposition: "blocked" });
    delete env.SANDBOX0_TOKEN;
    expect(() => configuredCloudWorkspaceProvider(env, false)).toThrow(expect.objectContaining({ code: "missing_configuration" }));
  });
});
