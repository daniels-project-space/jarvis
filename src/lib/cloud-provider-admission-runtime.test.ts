import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { cloudProviderAdmissionReadinessAtRuntime } from "./cloud-provider-admission-runtime";

const digest = "a".repeat(64);
const now = Date.now();
const environment = {
  JARVIS_CLOUD_WORKSPACE_PROVIDER: "vercel",
  JARVIS_CLOUD_WORKSPACE_TEMPLATE: "node22",
  JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: digest,
};
const receipt = JSON.stringify({
  keyId: "20260829-v1",
  signature: "b".repeat(64),
  receipt: {
    schemaVersion: 1,
    provider: "vercel",
    deploymentId: "20260829.1",
    template: { identity: "node22", digest },
    probeTime: now - 1_000,
    expiresAt: now + 60_000,
  },
});

describe("runtime cloud provider admission", () => {
  it("uses the readable Trigger proof rather than an app deployment snapshot", async () => {
    const result = await cloudProviderAdmissionReadinessAtRuntime({
      environment,
      retrieve: async (name) => ({
        name,
        value: name.endsWith("DEPLOYMENT_ID") ? "20260829.1" : receipt,
        isSecret: false,
      }),
    });

    expect(result).toEqual({ ready: true });
  });

  it("fails closed for redacted, renamed, or unavailable Trigger proof values", async () => {
    await expect(cloudProviderAdmissionReadinessAtRuntime({
      environment,
      retrieve: async (name) => ({ name, value: "redacted", isSecret: true }),
    })).resolves.toEqual({ ready: false, code: "missing_configuration" });

    await expect(cloudProviderAdmissionReadinessAtRuntime({
      environment,
      retrieve: async () => { throw new Error("unavailable"); },
    })).resolves.toEqual({ ready: false, code: "missing_configuration" });
  });
});
