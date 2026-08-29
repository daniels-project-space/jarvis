import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => ({
  definitions: new Map<string, any>(),
  metadata: { set: vi.fn() },
  upload: vi.fn(),
  retrieve: vi.fn(),
  issueProbe: vi.fn(),
  loadVault: vi.fn(),
}));
trigger.metadata.set.mockImplementation(() => trigger.metadata);

vi.mock("@trigger.dev/sdk/v3", () => ({
  envvars: { upload: trigger.upload, retrieve: trigger.retrieve },
  metadata: trigger.metadata,
  task: (definition: any) => {
    trigger.definitions.set(definition.id, definition);
    return definition;
  },
}));

vi.mock("../lib/vault-client", () => ({ vaultService: trigger.loadVault }));
vi.mock("../../scripts/probe-cloud-workspace-provider", () => ({ issueLiveCloudProviderProbe: trigger.issueProbe }));

import {
  bootstrapCurrentCloudProviderProbe,
  cloudProviderProbeBootstrap,
} from "./cloud-provider-probe-bootstrap";

const DEPLOYMENT_ID = "trigger-deploy-2026-08-29-a";
const CAPABILITY = "owner-probe-bootstrap-capability-32chars";

function environment() {
  return {
    JARVIS_CLOUD_PROVIDER_PROBE: "live",
    JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0",
  };
}

function envelope(deploymentId = DEPLOYMENT_ID) {
  return {
    keyId: "current",
    signature: "a".repeat(64),
    receipt: { deploymentId },
  } as any;
}

describe("owner Trigger cloud provider probe bootstrap", () => {
  beforeEach(() => {
    trigger.definitions.clear();
    trigger.metadata.set.mockClear();
    trigger.upload.mockReset();
    trigger.retrieve.mockReset();
    trigger.issueProbe.mockReset();
    trigger.loadVault.mockReset();
  });

  it("runs only as a manual, non-retrying single-concurrency Trigger task", () => {
    expect(cloudProviderProbeBootstrap).toMatchObject({
      id: "jarvis-cloud-provider-probe-bootstrap",
      maxDuration: 900,
      retry: { maxAttempts: 0 },
      queue: { name: "jarvis-cloud-provider-probe-bootstrap", concurrencyLimit: 1 },
    });
    const definition = cloudProviderProbeBootstrap as unknown as { run: () => unknown };
    expect(String(definition.run)).toContain("async (_payload, { ctx })");
    const source = readFileSync(new URL("./cloud-provider-probe-bootstrap.ts", import.meta.url), "utf8");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("JARVIS_CLOUD_PROVIDER_PROBE_KEYRING");
  });

  it("issues against ctx.deployment.version then uploads and verifies only the mutable proof pair", async () => {
    const stored = new Map<string, string>();
    trigger.loadVault.mockResolvedValue({ CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY: CAPABILITY });
    trigger.issueProbe.mockResolvedValue(envelope());
    trigger.upload.mockImplementation(async ({ variables }: { variables: Record<string, string> }) => {
      Object.entries(variables).forEach(([name, value]) => stored.set(name, value));
    });
    trigger.retrieve.mockImplementation(async (name: string) => ({
      name,
      value: stored.get(name) ?? "",
      isSecret: false,
    }));

    await expect(bootstrapCurrentCloudProviderProbe({ triggerDeploymentVersion: DEPLOYMENT_ID }, {
      environment: environment(),
    })).resolves.toEqual({ status: "attested", deploymentId: DEPLOYMENT_ID });

    expect(trigger.issueProbe).toHaveBeenCalledWith(expect.objectContaining({
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: DEPLOYMENT_ID,
    }));
    expect(trigger.upload).toHaveBeenCalledWith({
      variables: expect.objectContaining({
        JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: DEPLOYMENT_ID,
        JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: expect.any(String),
      }),
      override: true,
    });
    expect(Object.keys(trigger.upload.mock.calls[0][0].variables).sort()).toEqual([
      "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID",
      "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT",
    ]);
    expect(trigger.retrieve).toHaveBeenCalledWith("JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID");
    expect(trigger.retrieve).toHaveBeenCalledWith("JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT");
  });

  it("rejects before provider activity without the exact live opt-in or Vault-only owner capability", async () => {
    const issueProbe = vi.fn();
    const loadVault = vi.fn(async () => ({ CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY: CAPABILITY }));
    await expect(bootstrapCurrentCloudProviderProbe({ triggerDeploymentVersion: DEPLOYMENT_ID }, {
      environment: { ...environment(), JARVIS_CLOUD_PROVIDER_PROBE: "dormant" },
      loadVault,
      issueProbe,
    })).rejects.toThrow(/not enabled/);
    expect(loadVault).not.toHaveBeenCalled();
    expect(issueProbe).not.toHaveBeenCalled();

    await expect(bootstrapCurrentCloudProviderProbe({ triggerDeploymentVersion: DEPLOYMENT_ID }, {
      environment: environment(),
      loadVault: async () => ({}),
      issueProbe,
    })).rejects.toThrow(/owner cloud provider probe capability/);
    expect(issueProbe).not.toHaveBeenCalled();
  });

  it("fails closed if Trigger redacts either stored proof value", async () => {
    const issueProbe = vi.fn(async () => envelope());
    const uploadEnvironment = vi.fn(async () => undefined);
    await expect(bootstrapCurrentCloudProviderProbe({ triggerDeploymentVersion: DEPLOYMENT_ID }, {
      environment: environment(),
      loadVault: async () => ({ CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY: CAPABILITY }),
      issueProbe,
      uploadEnvironment,
      retrieveEnvironment: async (name) => ({ name, value: "redacted", isSecret: true }),
    })).rejects.toThrow(/readable non-secret evidence/);
    expect(uploadEnvironment).toHaveBeenCalledTimes(1);
  });

  it("never persists a receipt that does not name the actual Trigger deployment", async () => {
    const uploadEnvironment = vi.fn(async () => undefined);
    await expect(bootstrapCurrentCloudProviderProbe({ triggerDeploymentVersion: DEPLOYMENT_ID }, {
      environment: environment(),
      loadVault: async () => ({ CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY: CAPABILITY }),
      issueProbe: async () => envelope("trigger-deploy-2026-08-29-b"),
      uploadEnvironment,
    })).rejects.toThrow(/did not bind to the current Trigger deployment/);
    expect(uploadEnvironment).not.toHaveBeenCalled();
  });
});
