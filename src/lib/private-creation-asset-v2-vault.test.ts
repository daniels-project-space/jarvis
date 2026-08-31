import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TRUSTED_VAULT = "https://fantastic-roadrunner-485.convex.cloud";
const ENDPOINT = `${TRUSTED_VAULT}/api/query`;

function responseAt(url: string, body?: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("private creation V2 dedicated vault boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fails before any request when only the legacy generic vault capability exists", async () => {
    vi.stubEnv("VAULT_ACCESS_TOKEN", "legacy-generic-capability-must-not-reach-v2");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { getPrivateCreationAssetV2VaultSecrets } = await import("./private-creation-asset-v2-vault");

    await expect(getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the fixed V2-only backend contract without a generic service selector", async () => {
    const genericToken = "legacy-generic-capability-must-not-reach-v2";
    const v2Token = "v2-only-capability";
    vi.stubEnv("VAULT_ACCESS_TOKEN", genericToken);
    vi.stubEnv("JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN", v2Token);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseAt(ENDPOINT, JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare-private-r2-v2",
        secrets: {
          R2_ACCESS_KEY_ID: "test-v2-access-key",
          R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
          R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const {
      getPrivateCreationAssetV2VaultSecrets,
      PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE,
    } = await import("./private-creation-asset-v2-vault");

    await expect(getPrivateCreationAssetV2VaultSecrets()).resolves.toEqual({
      R2_ACCESS_KEY_ID: "test-v2-access-key",
      R2_SECRET_ACCESS_KEY: "test-v2-secret-key",
      R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    });

    expect(PRIVATE_CREATION_ASSET_V2_VAULT_SERVICE).toBe("cloudflare-private-r2-v2");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(ENDPOINT);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "privateCreationAssetV2:credentials",
      args: { v2VaultToken: v2Token },
      format: "json",
    });
    expect(String(init?.body)).not.toContain(genericToken);
    expect(String(init?.body)).not.toContain("service");
  });

  it("fails closed when the backend treats a legacy bearer as the V2 token or returns a non-V2 envelope", async () => {
    vi.stubEnv("JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN", "legacy-generic-capability");
    const denied = vi.fn(async () => responseAt(ENDPOINT, null, { status: 403 }));
    vi.stubGlobal("fetch", denied);
    const { getPrivateCreationAssetV2VaultSecrets } = await import("./private-creation-asset-v2-vault");

    await expect(getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");
    expect(denied).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ method: "POST" }));

    vi.resetModules();
    const wrongEnvelope = vi.fn(async () => responseAt(ENDPOINT, JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare_private_r2_v2",
        secrets: { R2_ACCESS_KEY_ID: "x" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", wrongEnvelope);
    const fresh = await import("./private-creation-asset-v2-vault");

    await expect(fresh.getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");
  });

  it("rejects a partial otherwise-valid V2 credential envelope", async () => {
    vi.stubEnv("JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN", "v2-only-capability");
    vi.stubGlobal("fetch", async () => responseAt(ENDPOINT, JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare-private-r2-v2",
        secrets: { R2_ACCESS_KEY_ID: "test-v2-access-key" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { getPrivateCreationAssetV2VaultSecrets } = await import("./private-creation-asset-v2-vault");

    await expect(getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");
  });

  it("rejects a forged response origin or extra secret fields before credentials can be used", async () => {
    vi.stubEnv("JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN", "v2-only-capability");
    vi.stubGlobal("fetch", async () => responseAt("https://hostile.example/api/query", JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare-private-r2-v2",
        secrets: { R2_ACCESS_KEY_ID: "x" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { getPrivateCreationAssetV2VaultSecrets } = await import("./private-creation-asset-v2-vault");

    await expect(getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");

    vi.resetModules();
    vi.stubGlobal("fetch", async () => responseAt(ENDPOINT, JSON.stringify({
      status: "success",
      value: {
        service: "cloudflare-private-r2-v2",
        secrets: { R2_ACCESS_KEY_ID: "x", UNRELATED_SECRET: "must-not-leak" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const fresh = await import("./private-creation-asset-v2-vault");

    await expect(fresh.getPrivateCreationAssetV2VaultSecrets()).rejects.toThrow("V2 vault capability unavailable");
  });
});
