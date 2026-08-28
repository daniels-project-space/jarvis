import { afterEach, describe, expect, it, vi } from "vitest";

const TRUSTED_VAULT = "https://fantastic-roadrunner-485.convex.cloud";

function responseAt(url: string, body?: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("vault client transport boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("refuses redirects without replaying the POST capability", async () => {
    const capability = "vault-capability-must-not-escape";
    vi.stubEnv("VAULT_ACCESS_TOKEN", capability);
    vi.stubEnv("VAULT_URL", TRUSTED_VAULT);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(capability, {
        status: 302,
        headers: { location: "https://hostile.example/collect" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { vaultFailureStage, vaultService } = await import("./vault-client");

    let error: unknown;
    try { await vaultService("codex-session"); } catch (caught) { error = caught; }
    expect(String(error)).toBe("Error: Vault request unavailable");
    expect(vaultFailureStage(error)).toBe("origin");
    expect(String(error)).not.toContain(capability);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${TRUSTED_VAULT}/api/query`);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ "content-length": String(Buffer.byteLength(String(init?.body))) });
  });

  it("rejects a hostile configured vault origin before it receives the capability", async () => {
    vi.stubEnv("VAULT_ACCESS_TOKEN", "vault-capability-must-not-be-sent");
    vi.stubEnv("VAULT_URL", "https://hostile.example/convex-lookalike");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { vaultService } = await import("./vault-client");

    await expect(vaultService("codex-session")).rejects.toThrow("Vault request unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts only bounded, duplicate-free success envelopes from the exact origin", async () => {
    vi.stubEnv("VAULT_ACCESS_TOKEN", "vault-capability");
    const endpoint = `${TRUSTED_VAULT}/api/query`;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseAt(endpoint, JSON.stringify({
      status: "success",
      value: [{ keyName: "R2_BUCKET", value: "private-bucket" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const { vaultService } = await import("./vault-client");
    await expect(vaultService("codex-session")).resolves.toEqual({ R2_BUCKET: "private-bucket" });

    vi.resetModules();
    vi.stubGlobal("fetch", async () => responseAt(endpoint,
      '{"status":"success","status":"error","value":[]}',
      { status: 200, headers: { "content-type": "application/json" } }));
    const duplicateClient = await import("./vault-client");
    await expect(duplicateClient.vaultService("codex-session")).rejects.toThrow("Vault request unavailable");

    vi.resetModules();
    vi.stubGlobal("fetch", async () => responseAt(endpoint, null, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(513 * 1_024) },
    }));
    const oversizedClient = await import("./vault-client");
    await expect(oversizedClient.vaultService("codex-session")).rejects.toThrow("Vault request unavailable");
  });

  it("accepts the fixed legacy Apple Calendar service name without widening the request shape", async () => {
    vi.stubEnv("VAULT_ACCESS_TOKEN", "vault-capability");
    const endpoint = `${TRUSTED_VAULT}/api/query`;
    let requestBody = "";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return responseAt(endpoint, JSON.stringify({
        status: "success",
        value: [
          { keyName: "APPLE_ID", value: "owner@example.com" },
          { keyName: "APPLE_APP_PASSWORD", value: "app-password" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const { vaultService } = await import("./vault-client");

    await expect(vaultService("apple_calendar")).resolves.toEqual({
      APPLE_ID: "owner@example.com",
      APPLE_APP_PASSWORD: "app-password",
    });
    expect(JSON.parse(requestBody)).toMatchObject({
      path: "secrets:listByService",
      args: { service: "apple_calendar" },
    });
  });

  it("aborts a stalled vault body instead of holding controller work forever", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VAULT_ACCESS_TOKEN", "vault-capability");
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const { vaultService } = await import("./vault-client");
    const pending = vaultService("codex-session");
    const rejected = expect(pending).rejects.toThrow("Vault request unavailable");
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    vi.useRealTimers();
  });
});
