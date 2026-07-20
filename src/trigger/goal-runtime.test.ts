import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Goal Mode external runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("CONVEX_URL", "https://jarvis.test");
    vi.stubEnv("APP_FACTORY_CONVEX_URL", "https://factory.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns Sol refinements to the same App Factory run with a stable wave key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { requestAppFactoryRefinement } = await import("./goal-runtime");
    await requestAppFactoryRefinement("factory-run-1", {
      verdict: "refine",
      summary: "One gap remains",
      evidence: ["build passed"],
      gaps: ["mobile navigation clips"],
      refinements: [{ id: "mobile", label: "Mobile", task: "Repair the mobile navigation and verify the real flow.", acceptanceCriteria: ["No clipping"] }],
    }, 2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://factory.test/api/mutation");
    const body = JSON.parse(String(init.body));
    expect(body.path).toBe("apps:requestChanges");
    expect(body.args.id).toBe("factory-run-1");
    expect(body.args.text).toContain("[JARVIS-GOAL-WAVE-2]");
    expect(body.args.text).toContain("mobile navigation clips");
  });

  it("surfaces repeated external read failures through Jarvis's durable failure counter", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url === "https://jarvis.test/api/query" && body.path === "goalMode:externalPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalKind: "app-factory", externalRunId: "missing-run" }] }), { status: 200 });
      }
      if (url === "https://factory.test/api/query") {
        return new Response(JSON.stringify({ status: "error", errorMessage: "not found" }), { status: 500 });
      }
      if (url === "https://jarvis.test/api/mutation" && body.path === "goalMode:recordExternalPollFailure") {
        return new Response(JSON.stringify({ value: { recorded: true, blocked: true, failures: 12 } }), { status: 200 });
      }
      throw new Error(`unexpected request ${url} ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalRuns } = await import("./goal-runtime");
    await expect(syncExternalGoalRuns()).resolves.toMatchObject({ checked: 1, blocked: 1, wake: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("applies and acknowledges the external control outbox", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.path);
      if (body.path === "goalMode:externalControlsPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalRunId: "run-1", action: "pause" }] }), { status: 200 });
      }
      if (body.path === "apps:setPaused") {
        expect(body.args).toEqual({ id: "run-1", paused: true });
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      if (body.path === "goalMode:acknowledgeExternalControl") {
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      throw new Error(`unexpected request ${url} ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalControls } = await import("./goal-runtime");
    await expect(syncExternalGoalControls()).resolves.toEqual({ checked: 1, applied: 1, blocked: 0 });
    expect(seen).toEqual(["goalMode:externalControlsPending", "apps:setPaused", "goalMode:acknowledgeExternalControl"]);
  });

  it("maps a failed factory recovery to the provider's retry operation", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.path);
      if (body.path === "goalMode:externalControlsPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalRunId: "run-1", action: "retry" }] }), { status: 200 });
      }
      if (body.path === "apps:retry") {
        expect(body.args).toEqual({ id: "run-1" });
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      if (body.path === "goalMode:acknowledgeExternalControl") {
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      throw new Error(`unexpected request ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalControls } = await import("./goal-runtime");
    await expect(syncExternalGoalControls()).resolves.toEqual({ checked: 1, applied: 1, blocked: 0 });
    expect(seen).toEqual(["goalMode:externalControlsPending", "apps:retry", "goalMode:acknowledgeExternalControl"]);
  });

  it("replays the durable revision outbox into the same App Factory run and acknowledges its wave", async () => {
    const validation = {
      verdict: "refine",
      summary: "A mobile gap remains",
      evidence: ["desktop passed"],
      gaps: ["mobile navigation clips"],
      refinements: [{ id: "mobile", label: "Mobile", task: "Repair the mobile navigation and verify the real flow.", acceptanceCriteria: ["No clipping"] }],
    };
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.path);
      if (body.path === "goalMode:externalRevisionsPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalRunId: "run-1", wave: 3, validation }] }), { status: 200 });
      }
      if (body.path === "apps:requestChanges") {
        expect(body.args.id).toBe("run-1");
        expect(body.args.text).toContain("[JARVIS-GOAL-WAVE-3]");
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      if (body.path === "goalMode:acknowledgeExternalRevision") {
        expect(body.args).toMatchObject({ id: "mission-1", wave: 3 });
        return new Response(JSON.stringify({ value: true }), { status: 200 });
      }
      throw new Error(`unexpected request ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalRevisions } = await import("./goal-runtime");
    await expect(syncExternalGoalRevisions()).resolves.toEqual({ checked: 1, applied: 1, blocked: 0 });
    expect(seen).toEqual(["goalMode:externalRevisionsPending", "apps:requestChanges", "goalMode:acknowledgeExternalRevision"]);
  });

  it("keeps a failed external revision durable and records the provider error", async () => {
    const validation = {
      verdict: "refine",
      summary: "A gap remains",
      evidence: [],
      gaps: ["broken flow"],
      refinements: [{ id: "flow", label: "Flow", task: "Repair and verify the broken production flow.", acceptanceCriteria: ["Flow passes"] }],
    };
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.path);
      if (body.path === "goalMode:externalRevisionsPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalRunId: "run-1", wave: 2, validation }] }), { status: 200 });
      }
      if (body.path === "apps:requestChanges") {
        return new Response(JSON.stringify({ status: "error", errorMessage: "provider unavailable" }), { status: 503 });
      }
      if (body.path === "goalMode:recordExternalActionFailure") {
        expect(body.args).toMatchObject({ id: "mission-1", action: "refine" });
        return new Response(JSON.stringify({ value: { recorded: true, blocked: true, failures: 12 } }), { status: 200 });
      }
      throw new Error(`unexpected request ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalRevisions } = await import("./goal-runtime");
    await expect(syncExternalGoalRevisions()).resolves.toEqual({ checked: 1, applied: 0, blocked: 1 });
    expect(seen).toEqual(["goalMode:externalRevisionsPending", "apps:requestChanges", "goalMode:recordExternalActionFailure"]);
  });

  it("does not spend another Convex write after an external outage is already surfaced", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(body.path);
      if (body.path === "goalMode:externalPending") {
        return new Response(JSON.stringify({ value: [{ id: "mission-1", externalKind: "app-factory", externalRunId: "run-1", externalPollFailures: 12 }] }), { status: 200 });
      }
      if (body.path === "apps:get") {
        return new Response(JSON.stringify({ status: "error", errorMessage: "still unavailable" }), { status: 503 });
      }
      throw new Error(`unexpected request ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncExternalGoalRuns } = await import("./goal-runtime");
    await expect(syncExternalGoalRuns()).resolves.toEqual({ checked: 1, updated: 0, blocked: 1, wake: false });
    expect(seen).toEqual(["goalMode:externalPending", "apps:get"]);
  });

  it("writes a compact coordinator receipt only through the worker capability", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.path).toBe("goalMode:recordCoordinatorReceipt");
      expect(body.args).toMatchObject({
        deploymentVersion: "trigger-v42",
        demand: { needed: true, reasons: ["runnable goal work"] },
        controls: { checked: 2, applied: 1, blocked: 0 },
        revisions: { checked: 1, applied: 0, blocked: 0 },
        external: { checked: 3, updated: 1, blocked: 0 },
        wakeRequested: true,
        wakeResult: "dispatched",
        wakeTarget: "trigger:jarvis-agent-worker",
        wakeReason: "goal-coordinator",
        workerToken: "worker-capability",
      });
      return new Response(JSON.stringify({ value: { id: "receipt-1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { recordGoalCoordinatorReceipt } = await import("./goal-runtime");
    await expect(recordGoalCoordinatorReceipt({
      deploymentVersion: "trigger-v42",
      demand: { needed: true, reasons: ["runnable goal work"] },
      controls: { checked: 2, applied: 1, blocked: 0 },
      revisions: { checked: 1, applied: 0, blocked: 0 },
      external: { checked: 3, updated: 1, blocked: 0 },
      wakeRequested: true,
      wakeResult: "dispatched",
      wakeTarget: "trigger:jarvis-agent-worker",
      wakeReason: "goal-coordinator",
    })).resolves.toEqual({ id: "receipt-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds an exact receipt payload with Trigger's real deployment version", async () => {
    const { createGoalCoordinatorReceipt, goalCoordinatorDeploymentVersion } = await import("./goal-runtime");
    const deploymentVersion = goalCoordinatorDeploymentVersion("20260719.5", {
      TRIGGER_DEPLOYMENT_VERSION: "20260719.5",
      TRIGGER_VERSION: "legacy-version",
      GITHUB_SHA: "fallback-sha",
    });
    const receipt = createGoalCoordinatorReceipt({
      deploymentVersion,
      demand: { needed: true, reasons: ["runnable goal work"] },
      controls: { checked: 2, applied: 1, blocked: 0 },
      revisions: { checked: 1, applied: 0, blocked: 0 },
      external: { checked: 3, updated: 1, blocked: 0, wake: true },
      shouldWake: true,
      woken: true,
    });

    expect(deploymentVersion).toBe("20260719.5");
    expect(goalCoordinatorDeploymentVersion(undefined, { TRIGGER_VERSION: "legacy-version" })).toBe("legacy-version");
    expect(receipt.external).toEqual({ checked: 3, updated: 1, blocked: 0, error: undefined });
    expect(receipt.external).not.toHaveProperty("wake");
    expect(receipt).toMatchObject({
      wakeRequested: true,
      wakeResult: "dispatched",
      wakeTarget: "trigger:jarvis-agent-worker",
      wakeReason: "goal-coordinator",
    });
  });
});
