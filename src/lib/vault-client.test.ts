import { afterEach, describe, expect, it, vi } from "vitest";

const TRUSTED_VAULT = "https://fantastic-roadrunner-485.convex.cloud";

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
    const { vaultService } = await import("./vault-client");

    let error: unknown;
    try { await vaultService("codex-session"); } catch (caught) { error = caught; }
    expect(String(error)).toBe("Error: Vault request unavailable");
    expect(String(error)).not.toContain(capability);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${TRUSTED_VAULT}/api/query`);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
});
