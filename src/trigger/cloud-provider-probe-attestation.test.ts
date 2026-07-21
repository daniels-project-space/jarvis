import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_PROVIDER_PROBE_MAX_AGE_MS,
  actualTriggerDeploymentId,
  canonicalProviderProbeJson,
  configuredCloudProviderProbeBinding,
  createCloudProviderProbeKeyring,
  type CloudProviderProbeEnvelope,
  type CloudProviderProbeReceipt,
  type CloudProviderRuntimeAttestation,
} from "./cloud-provider-probe-attestation";
import { DEFAULT_WORKSPACE_LIMITS, REQUIRED_CLOUD_WORKSPACE_CAPABILITIES } from "./cloud-workspace";
import {
  configuredCloudWorkspaceCleanupProvider,
  configuredCloudWorkspaceProvider,
} from "./cloud-workspace-providers";
import { prepareCloudWorkspaceExecution } from "./cloud-workspace-controller";

const NOW = Date.now();
const SECRET = "controller-provider-probe-secret-32-bytes-minimum";
const DIGEST = "a".repeat(64);
const DEPLOYMENT_VERSION = "trigger-deploy-2026-07-21-a";
const RUNTIME_ATTESTATION: CloudProviderRuntimeAttestation = {
  triggerDeploymentVersion: DEPLOYMENT_VERSION,
};

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE: "template-immutable-v7",
    JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: DIGEST,
    JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: DEPLOYMENT_VERSION,
    TRIGGER_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
    TRIGGER_VERSION: DEPLOYMENT_VERSION,
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
    env.JARVIS_CLOUD_PROVIDER_PROBE = "live";
    delete env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT;
    expect(() => configuredCloudWorkspaceProvider(env, RUNTIME_ATTESTATION)).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked", provider: "sandbox0",
    }));
    const hydrate = vi.fn();
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => configuredCloudWorkspaceProvider(env, RUNTIME_ATTESTATION),
      hydrateArchive: hydrate,
      attemptKey: "blocked:1", template: env.JARVIS_CLOUD_WORKSPACE_TEMPLATE!,
      runtime: "node-22:codex-0.144.5", lockfileDigest: "0".repeat(64),
    })).rejects.toMatchObject({ code: "provider_probe_attestation_failed", disposition: "blocked" });
    expect(hydrate).not.toHaveBeenCalled();
    expect(() => configuredCloudWorkspaceProvider({ ...env, SANDBOX0_TOKEN: undefined }, RUNTIME_ATTESTATION)).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked",
    }));
    const source = readFileSync(join(process.cwd(), "src/trigger/cloud-workspace-providers.ts"), "utf8");
    const configured = source.slice(source.indexOf("export function configuredCloudWorkspaceProvider("), source.indexOf("/** Orphan cleanup"));
    expect(configured.indexOf("assertCloudProviderExecutionReady(env, runtimeAttestation)")).toBeLessThan(configured.indexOf("configuredProviderAdapter(env)"));
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    expect(runner).toContain("runtimeAttestation: { triggerDeploymentVersion: ctx.deployment?.version }");
    expect(runner).not.toContain("configuredCloudWorkspaceProviderForLiveProbe");
    expect(runner.match(/options\.runtimeAttestation/g)).toHaveLength(1);
    expect(runner.lastIndexOf("cloudProvider = configuredCloudWorkspaceProvider(process.env, options.runtimeAttestation)")).toBeLessThan(runner.indexOf("await processJob(job, cloudProvider)"));
  });

  it("opens execution for the exact ctx.deployment.version and a fresh signed provider tuple", () => {
    const env = signedEnvironment();
    expect(configuredCloudWorkspaceProvider(env, RUNTIME_ATTESTATION).name).toBe("sandbox0");
    for (const changed of [
      { JARVIS_CLOUD_WORKSPACE_PROVIDER: "e2b", E2B_API_KEY: "test", SANDBOX0_TOKEN: undefined },
      { JARVIS_CLOUD_WORKSPACE_TEMPLATE: "other-template" },
      { JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: "b".repeat(64) },
      { JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "other-deployment" },
    ]) {
      expect(() => configuredCloudWorkspaceProvider({ ...env, ...changed }, RUNTIME_ATTESTATION)).toThrow(expect.objectContaining({
        code: "provider_probe_attestation_failed", disposition: "blocked",
      }));
    }
  });

  it("rejects an otherwise valid signed receipt after the actual Trigger deployment version changes", () => {
    const env = signedEnvironment();
    expect(() => configuredCloudWorkspaceProvider(env, {
      triggerDeploymentVersion: "trigger-deploy-2026-07-21-b",
    })).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked",
      message: expect.stringMatching(/actual Trigger worker deployment/),
    }));
  });

  it("does not let matching environment or configuration claims override mismatched runtime context", () => {
    const env = signedEnvironment();
    expect(() => configuredCloudWorkspaceProvider({
      ...env,
      NODE_ENV: "production",
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: DEPLOYMENT_VERSION,
      TRIGGER_VERSION: DEPLOYMENT_VERSION,
      TRIGGER_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
    }, { triggerDeploymentVersion: "trigger-deploy-2026-07-21-b" })).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked",
    }));
    expect(actualTriggerDeploymentId({
      triggerDeploymentVersion: "trigger-deploy-2026-07-21-b",
    }, "sandbox0")).toBe("trigger-deploy-2026-07-21-b");
    const source = readFileSync(join(process.cwd(), "src/trigger/cloud-provider-probe-attestation.ts"), "utf8");
    const actualIdentity = source.slice(source.indexOf("export function actualTriggerDeploymentId("), source.indexOf("/** Normal worker verification"));
    expect(actualIdentity).not.toMatch(/TRIGGER_VERSION|TRIGGER_DEPLOYMENT_VERSION|NODE_ENV|JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID/);
  });

  it.each([
    { version: undefined, label: "missing" },
    { version: "bad deployment value", label: "malformed" },
    { version: "unversioned", label: "unversioned" },
    { version: "worker-unversioned", label: "unversioned placeholder" },
  ])("blocks execution when the SDK runtime deployment identity is $label", ({ version }) => {
    const env = signedEnvironment();
    expect(() => configuredCloudWorkspaceProvider(env, { triggerDeploymentVersion: version })).toThrow(expect.objectContaining({
      code: "provider_probe_attestation_failed", disposition: "blocked",
    }));
  });

  it("never fills missing runtime context from Trigger or configured environment claims", () => {
    const env = {
      ...signedEnvironment(),
      NODE_ENV: "production",
      TRIGGER_DEPLOYMENT_VERSION: DEPLOYMENT_VERSION,
      TRIGGER_VERSION: DEPLOYMENT_VERSION,
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: DEPLOYMENT_VERSION,
    };
    expect(() => configuredCloudWorkspaceProvider(env, {
      triggerDeploymentVersion: undefined,
    })).toThrow(expect.objectContaining({ code: "provider_probe_attestation_failed", disposition: "blocked" }));
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
      expect(() => configuredCloudWorkspaceProvider(candidate, RUNTIME_ATTESTATION)).toThrow(expect.objectContaining({
        code: "provider_probe_attestation_failed", disposition: "blocked",
      }));
    },
  );

  it("keeps cleanup authority narrowly available without an execution receipt", () => {
    const env = baseEnvironment();
    delete env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT;
    const cleanup = configuredCloudWorkspaceCleanupProvider(env);
    expect(cleanup.name).toBe("sandbox0");
    expect(Object.keys(cleanup).sort()).toEqual(["name", "terminate"]);
    expect(cleanup.terminate).toBeTypeOf("function");
    expect("createWorkspace" in cleanup).toBe(false);
    delete env.SANDBOX0_TOKEN;
    expect(() => configuredCloudWorkspaceCleanupProvider(env)).toThrow(expect.objectContaining({ code: "missing_configuration" }));
  });
});
