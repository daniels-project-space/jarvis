import { describe, expect, it } from "vitest";
import { readSelfHostedAgentFleetConfig } from "./self-hosted-agent-fleet-config";

const valid = {
  JARVIS_SELF_HOSTED_AGENT_FLEET: "live",
  JARVIS_SELF_HOSTED_AGENT_FLEET_INSTANCE: "daniel-vps",
  JARVIS_SELF_HOSTED_AGENT_FLEET_STATE_DIR: "/var/lib/jarvis-agent-fleet",
  JARVIS_SELF_HOSTED_AGENT_FLEET_NOT_BEFORE_MS: "1788170000000",
  JARVIS_CODEX_SESSION_SOURCE: "vault-broker",
  JARVIS_CLOUD_WORKSPACE_PROVIDER: "selfhost",
  JARVIS_CLOUD_PROVIDER_PROBE: "live",
  JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "selfhost-controller:release-1",
  JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "receipt",
  JARVIS_CLOUD_PROVIDER_PROBE_KEYRING: "keyring",
  JARVIS_CLOUD_WORKSPACE_TEMPLATE: "sha256:container",
  JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: "a".repeat(64),
  JARVIS_SELF_HOST_RUNNER_URL: "https://runner.example.test",
  JARVIS_SELF_HOST_RUNNER_TOKEN: "r".repeat(32),
  JARVIS_WORKER_TOKEN: "w".repeat(32),
  JARVIS_DISPATCH_TOKEN: "d".repeat(32),
  VAULT_ACCESS_TOKEN: "v".repeat(32),
  CONVEX_URL: "https://example.convex.cloud",
};

describe("self-hosted agent fleet configuration", () => {
  it("accepts one explicit outbound controller identity", () => {
    expect(readSelfHostedAgentFleetConfig(valid, "/srv/jarvis-app")).toEqual({
      instanceId: "daniel-vps",
      stateDirectory: "/var/lib/jarvis-agent-fleet",
      convexUrl: "https://example.convex.cloud",
      controllerDeploymentId: "selfhost-controller:release-1",
      admitCreatedAtOrAfter: 1_788_170_000_000,
      pollMs: 2_000,
    });
  });

  it.each([
    ["not enabled", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET: "off" }],
    ["wrong auth source", { ...valid, JARVIS_CODEX_SESSION_SOURCE: "local" }],
    ["paid provider", { ...valid, JARVIS_CLOUD_WORKSPACE_PROVIDER: "vercel" }],
    ["provider proof disabled", { ...valid, JARVIS_CLOUD_PROVIDER_PROBE: "off" }],
    ["unsafe instance", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET_INSTANCE: "../host" }],
    ["unsafe state", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET_STATE_DIR: "/srv/jarvis-app/state" }],
    ["missing cutoff", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET_NOT_BEFORE_MS: undefined }],
    ["historic cutoff", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET_NOT_BEFORE_MS: "1" }],
    ["root state", { ...valid, JARVIS_SELF_HOSTED_AGENT_FLEET_STATE_DIR: "/" }],
    ["short runner token", { ...valid, JARVIS_SELF_HOST_RUNNER_TOKEN: "short" }],
    ["wrong digest", { ...valid, JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST: "latest" }],
    ["unversioned controller", { ...valid, JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "latest release" }],
    ["non-https Convex", { ...valid, CONVEX_URL: "http://example.convex.cloud" }],
    ["Convex path", { ...valid, CONVEX_URL: "https://example.convex.cloud/api" }],
  ])("fails closed for %s", (_label, environment) => {
    expect(() => readSelfHostedAgentFleetConfig(environment, "/srv/jarvis-app")).toThrow();
  });
});
