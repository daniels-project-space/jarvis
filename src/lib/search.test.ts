import { afterEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  getSecret: vi.fn(),
  getServiceSecrets: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./vault", () => vault);

import { searchWeb } from "./search";

function ddgResponse(title = "Sesame AI", target = "https://example.com/sesame") {
  const encoded = encodeURIComponent(target);
  return new Response([
    `## [${title}](https://duckduckgo.com/l/?uddg=${encoded})`,
    `[A detailed result snippet about conversational voice agent research.](https://duckduckgo.com/l/?uddg=${encoded})`,
  ].join("\n"), { status: 200, headers: { "content-type": "text/markdown" } });
}

describe("bounded web search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.SERPER_API_KEY;
    delete process.env.SERPAPI_KEY;
  });

  it("runs a fixed keyless-first search without loading paid-provider secrets", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ddgResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("sesame-keyless-test", 5, "us", {
      providerOrder: "keyless-first",
      maxPaidAttempts: 0,
      cacheTtlMs: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("r.jina.ai/https://html.duckduckgo.com");
    expect(result?.results[0]).toMatchObject({ title: "Sesame AI", link: "https://example.com/sesame" });
    expect(vault.getSecret).not.toHaveBeenCalled();
    expect(vault.getServiceSecrets).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent requests and reuses only successful bounded results", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const options = { providerOrder: "keyless-first" as const, maxPaidAttempts: 0 as const, cacheTtlMs: 45_000 };
    const first = searchWeb("sesame-inflight-test", 5, "us", options);
    const second = searchWeb("  SESAME-inflight-test  ", 5, "us", options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(ddgResponse("Concurrent result"));
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(one).not.toBe(two);
    await expect(searchWeb("sesame-inflight-test", 5, "us", options)).resolves.toEqual(one);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates caller cancellation and never falls through to a paid provider", async () => {
    process.env.SERPER_API_KEY = "paid-provider-key";
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = searchWeb("sesame-abort-test", 5, "us", {
      signal: controller.signal,
      providerOrder: "keyless-first",
      maxPaidAttempts: 1,
      cacheTtlMs: 0,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vault.getServiceSecrets).not.toHaveBeenCalled();
  });

  it("enforces the caller deadline without starting another provider", async () => {
    process.env.SERPER_API_KEY = "paid-provider-key";
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = searchWeb("sesame-timeout-test", 5, "us", {
      timeoutMs: 10,
      providerOrder: "keyless-first",
      maxPaidAttempts: 1,
      cacheTtlMs: 0,
    });
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
