import { describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
}));

import {
  BACKGROUND_READINESS_MINIMUM_VALIDITY_MS,
  backgroundReadiness,
  runBackgroundReadinessProbe,
  type BackgroundReadinessDependencies,
} from "./background-readiness";

function response(value: unknown, ok = true) {
  return { ok, json: async () => value };
}

function testEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values };
}

function dependencies(overrides: Partial<BackgroundReadinessDependencies> = {}): BackgroundReadinessDependencies {
  return {
    environment: testEnv({
      CONVEX_URL: "https://jarvis-readiness.test",
      JARVIS_WORKER_TOKEN: "worker-token",
    }),
    fetch: vi.fn(async () => response({ value: { state: "clear" } })),
    resolveSubscriptionAgentBin: vi.fn(() => "/usr/local/bin/codex"),
    prepareSubscriptionEnv: vi.fn<BackgroundReadinessDependencies["prepareSubscriptionEnv"]>(async () => ({
      env: testEnv({ CODEX_HOME: "/tmp/jarvis-readiness" }),
    })),
    verifyCodexSubscriptionPreflight: vi.fn<BackgroundReadinessDependencies["verifyCodexSubscriptionPreflight"]>(() => ({})),
    cleanupSubscriptionHome: vi.fn(),
    ...overrides,
  };
}

describe("background agent readiness probe", () => {
  it("is a one-click micro task rather than a scheduled or retrying worker", () => {
    expect(backgroundReadiness).toMatchObject({
      id: "jarvis-background-readiness",
      machine: "micro",
      retry: { maxAttempts: 1 },
      maxDuration: 45,
    });
    expect(backgroundReadiness).not.toHaveProperty("cron");
  });

  it("checks a real worker prerequisite chain without dispatching a job or model", async () => {
    const d = dependencies();

    await expect(runBackgroundReadinessProbe(d)).resolves.toEqual({
      ready: true,
      controllerSession: "clear",
      codex: { binary: "available", subscription: "acquired", preflight: "passed" },
    });
    expect(d.fetch).toHaveBeenCalledOnce();
    expect(d.fetch).toHaveBeenCalledWith(
      "https://jarvis-readiness.test/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "controllerSession:status",
          args: { workerToken: "worker-token" },
          format: "json",
        }),
      }),
    );
    expect(d.prepareSubscriptionEnv).toHaveBeenCalledWith("codex", {
      scope: "background-readiness",
      minimumValidityMs: BACKGROUND_READINESS_MINIMUM_VALIDITY_MS,
      environment: d.environment,
    });
    expect(d.verifyCodexSubscriptionPreflight).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      testEnv({ CODEX_HOME: "/tmp/jarvis-readiness" }),
    );
    expect(d.cleanupSubscriptionHome).toHaveBeenCalledWith(testEnv({ CODEX_HOME: "/tmp/jarvis-readiness" }));
  });

  it("does not acquire a session when a durable repair hold is present", async () => {
    const d = dependencies({
      fetch: vi.fn(async () => response({ value: { state: "repair_required", code: "rotation_uncertain" } })),
    });

    await expect(runBackgroundReadinessProbe(d)).resolves.toMatchObject({
      ready: false,
      controllerSession: "repair_required",
      blocker: "rotation_uncertain",
      codex: { binary: "not_checked", subscription: "not_checked", preflight: "not_checked" },
    });
    expect(d.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(d.prepareSubscriptionEnv).not.toHaveBeenCalled();
    expect(d.fetch).toHaveBeenCalledOnce();
  });

  it("fails closed before session acquisition when the control-plane read is unavailable", async () => {
    const d = dependencies({ fetch: vi.fn(async () => response({}, false)) });

    await expect(runBackgroundReadinessProbe(d)).resolves.toMatchObject({
      ready: false,
      controllerSession: "unknown",
      blocker: "controller_session_status_unavailable",
    });
    expect(d.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(d.prepareSubscriptionEnv).not.toHaveBeenCalled();
  });

  it("returns only the bounded session code and removes the consumer home on acquisition failure", async () => {
    const consumerEnv = testEnv({ CODEX_HOME: "/tmp/jarvis-readiness-failure" });
    const d = dependencies({
      prepareSubscriptionEnv: vi.fn(async () => ({
        env: consumerEnv,
        error: "JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: opaque controller detail",
      })),
    });

    await expect(runBackgroundReadinessProbe(d)).resolves.toMatchObject({
      ready: false,
      controllerSession: "clear",
      blocker: "rotation_uncertain",
      codex: { binary: "available", subscription: "unavailable", preflight: "not_checked" },
    });
    expect(d.verifyCodexSubscriptionPreflight).not.toHaveBeenCalled();
    expect(d.cleanupSubscriptionHome).toHaveBeenCalledWith(consumerEnv);
  });

  it("never reports ready when CLI preflight or cleanup fails", async () => {
    const preflightFailure = dependencies({
      verifyCodexSubscriptionPreflight: vi.fn(() => ({ error: "opaque local failure" })),
    });
    await expect(runBackgroundReadinessProbe(preflightFailure)).resolves.toMatchObject({
      ready: false,
      blocker: "codex_preflight_failed",
      codex: { preflight: "failed" },
    });

    const cleanupFailure = dependencies({
      cleanupSubscriptionHome: vi.fn(() => { throw new Error("cleanup failed"); }),
    });
    await expect(runBackgroundReadinessProbe(cleanupFailure)).resolves.toMatchObject({
      ready: false,
      blocker: "consumer_cleanup_failed",
    });
  });

  it("does not attempt any session work without the server-only worker capability", async () => {
    const d = dependencies({ environment: testEnv({ CONVEX_URL: "https://jarvis-readiness.test" }) });

    await expect(runBackgroundReadinessProbe(d)).resolves.toMatchObject({
      ready: false,
      controllerSession: "unknown",
      blocker: "worker_token_unavailable",
    });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.resolveSubscriptionAgentBin).not.toHaveBeenCalled();
    expect(d.prepareSubscriptionEnv).not.toHaveBeenCalled();
  });
});
