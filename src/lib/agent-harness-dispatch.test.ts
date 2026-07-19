import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("agent harness wake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("dispatches the pinned CLI workflow without embedding work in the request", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ workflow_runs: [] }) })
      .mockResolvedValueOnce({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const { wakeAgentHarness } = await import("./agent-harness-dispatch");

    await expect(wakeAgentHarness("job queued")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/actions/workflows/jarvis-agent-harness.yml/dispatches"),
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ ref: "main", inputs: { reason: "job queued" } });
  });

  it("does not dispatch a duplicate workspace while the harness is active", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [{ status: "in_progress" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { wakeAgentHarness } = await import("./agent-harness-dispatch");

    await expect(wakeAgentHarness("same eligible job")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/actions/workflows/jarvis-agent-harness.yml/runs"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
