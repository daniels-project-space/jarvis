import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("agent harness wake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("dispatches the pinned CLI workflow without embedding work in the request", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const { wakeAgentHarness } = await import("./agent-harness-dispatch");

    await expect(wakeAgentHarness("job queued")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/actions/workflows/jarvis-agent-harness.yml/dispatches"),
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ ref: "main", inputs: { reason: "job queued" } });
  });
});
