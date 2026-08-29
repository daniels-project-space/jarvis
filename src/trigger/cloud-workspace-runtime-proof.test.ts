import { beforeEach, describe, expect, it, vi } from "vitest";

const triggerEnvvars = vi.hoisted(() => ({
  retrieve: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  envvars: triggerEnvvars,
}));

import { configuredCloudWorkspaceProviderForCurrentTriggerDeployment } from "./cloud-workspace-providers";

describe("current Trigger cloud workspace proof", () => {
  beforeEach(() => {
    triggerEnvvars.retrieve.mockReset();
  });

  it("reads the mutable proof from Trigger and fails closed on a secret-redacted value", async () => {
    triggerEnvvars.retrieve.mockImplementation(async (name: string) => ({
      name,
      value: "redacted",
      isSecret: true,
    }));

    await expect(configuredCloudWorkspaceProviderForCurrentTriggerDeployment({
      JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0",
    }, {
      triggerDeploymentVersion: "trigger-deploy-2026-07-21-b",
    })).rejects.toMatchObject({
      provider: "sandbox0",
      code: "provider_probe_attestation_failed",
      disposition: "blocked",
    });

    expect(triggerEnvvars.retrieve).toHaveBeenCalledTimes(2);
    expect(triggerEnvvars.retrieve).toHaveBeenCalledWith("JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID");
    expect(triggerEnvvars.retrieve).toHaveBeenCalledWith("JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT");
  });
});
