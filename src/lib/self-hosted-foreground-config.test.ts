import { describe, expect, it } from "vitest";
import { readSelfHostedForegroundConfig } from "./self-hosted-foreground-config";

const valid = {
  JARVIS_SELF_HOSTED_FOREGROUND: "live",
  JARVIS_SELF_HOSTED_FOREGROUND_INSTANCE: "daniel-studio",
  JARVIS_SELF_HOSTED_FOREGROUND_STATE_DIR: "/var/lib/jarvis-foreground",
  JARVIS_CODEX_SESSION_SOURCE: "vault-broker",
  JARVIS_WORKER_TOKEN: "w".repeat(32),
  JARVIS_DISPATCH_TOKEN: "d".repeat(32),
  VAULT_ACCESS_TOKEN: "v".repeat(32),
  CONVEX_URL: "https://example.convex.cloud",
};

describe("self-hosted foreground configuration", () => {
  it("accepts only an explicit, isolated outbound runner configuration", () => {
    expect(readSelfHostedForegroundConfig(valid, "/srv/jarvis-app")).toEqual({
      instanceId: "daniel-studio",
      stateDirectory: "/var/lib/jarvis-foreground",
      convexUrl: "https://example.convex.cloud",
    });
  });

  it.each([
    ["not enabled", { ...valid, JARVIS_SELF_HOSTED_FOREGROUND: "off" }],
    ["wrong auth source", { ...valid, JARVIS_CODEX_SESSION_SOURCE: "local" }],
    ["unsafe instance", { ...valid, JARVIS_SELF_HOSTED_FOREGROUND_INSTANCE: "../host" }],
    ["short worker secret", { ...valid, JARVIS_WORKER_TOKEN: "short" }],
    ["checkout state", { ...valid, JARVIS_SELF_HOSTED_FOREGROUND_STATE_DIR: "/srv/jarvis-app/state" }],
    ["root state", { ...valid, JARVIS_SELF_HOSTED_FOREGROUND_STATE_DIR: "/" }],
    ["non-https Convex", { ...valid, CONVEX_URL: "http://example.convex.cloud" }],
    ["Convex path", { ...valid, CONVEX_URL: "https://example.convex.cloud/api" }],
  ])("fails closed for %s", (_label, environment) => {
    expect(() => readSelfHostedForegroundConfig(environment, "/srv/jarvis-app")).toThrow();
  });
});
