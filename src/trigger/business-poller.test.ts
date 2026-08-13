import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk/v3", () => ({
  schedules: { task: <T>(definition: T) => definition },
}));

import { pollYouTube } from "./business-poller";

const YOUTUBE = "https://astute-camel-689.convex.cloud";
const JARVIS = "https://tangible-goose-318.convex.cloud";

const envelope = (value: unknown, status = "success") =>
  new Response(JSON.stringify({ status, value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("business poller YouTube snapshot safety", () => {
  beforeEach(() => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves the existing snapshot when the YouTube upstream is unavailable", async () => {
    let query = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.startsWith(YOUTUBE)) {
        return query++ === 0
          ? new Response("upstream outage", { status: 503 })
          : envelope([]);
      }
      throw new Error(`unexpected write to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollYouTube()).resolves.toMatchObject({
      domain: "youtube",
      status: "unavailable",
      reason: "upstream HTTP 503",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(JARVIS))).toBe(false);
  });

  it.each([
    ["an invalid upstream status", () => envelope(null, "error"), "upstream returned status error"],
    ["an invalid upstream JSON body", () => new Response("not-json", { status: 200 }), "upstream returned invalid JSON"],
  ])("does not replace a snapshot after %s", async (_description, response, reason) => {
    let query = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.startsWith(YOUTUBE)) return query++ === 0 ? response() : envelope([]);
      throw new Error(`unexpected write to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollYouTube()).resolves.toMatchObject({
      domain: "youtube",
      status: "unavailable",
      reason,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(JARVIS))).toBe(false);
  });

  it("writes the explicit no-channel state only after successful empty reads", async () => {
    let query = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.startsWith(YOUTUBE)) return envelope(query++ === 0 ? null : []);
      if (url.startsWith(JARVIS)) return new Response("", { status: 200 });
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollYouTube()).resolves.toEqual({ domain: "youtube", status: "empty" });
    const write = fetchMock.mock.calls.find(([url]) => String(url).startsWith(JARVIS));
    expect(write).toBeDefined();
    const body = JSON.parse(String(write?.[1]?.body));
    expect(body.path).toBe("business:upsert");
    expect(body.args.headline).toContain("No YouTube channel is linked yet");
  });
});
