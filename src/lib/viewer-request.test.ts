import { afterEach, describe, expect, it, vi } from "vitest";
import { setViewerRequestToken, viewerFetch } from "./viewer-request";

describe("viewerFetch", () => {
  afterEach(() => {
    setViewerRequestToken(null);
    vi.unstubAllGlobals();
  });

  it("authenticates local API calls without leaking the capability cross-origin", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("window", { location: { origin: "https://jarvis.example" } });
    vi.stubGlobal("fetch", request);
    setViewerRequestToken("signed-viewer-token");

    await viewerFetch("/api/chat", { headers: { "content-type": "application/json" } });
    await viewerFetch("https://example.com/api/collect");

    const localHeaders = new Headers(request.mock.calls[0][1].headers);
    const externalHeaders = new Headers(request.mock.calls[1][1].headers);
    expect(localHeaders.get("authorization")).toBe("Bearer signed-viewer-token");
    expect(localHeaders.get("content-type")).toBe("application/json");
    expect(externalHeaders.has("authorization")).toBe(false);
  });
});
