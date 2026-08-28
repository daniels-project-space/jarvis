import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  isSameOriginRequest: vi.fn(),
  provePrivateCreationAssetV2Capability: vi.fn(),
  privateCreationAssetStoreConfigurationCode: vi.fn(),
  controlActor: vi.fn(),
  controlCredentials: vi.fn(),
  isOwnerActor: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
  isSameOriginRequest: mock.isSameOriginRequest,
}));
vi.mock("@/lib/private-creation-asset-store", () => ({
  provePrivateCreationAssetV2Capability: mock.provePrivateCreationAssetV2Capability,
  privateCreationAssetStoreConfigurationCode: mock.privateCreationAssetStoreConfigurationCode,
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  isOwnerActor: mock.isOwnerActor,
}));

import { POST } from "./route";

const VERCEL_PROOF_ID = "j57d9dbxe9b31fkrbkk7pg2h7n7caa3v";
const TRIGGER_PROOF_ID = "j57d9dbxe9b31fkrbkk7pg2h7n7caa3u";

function request(body?: unknown) {
  return new NextRequest("https://jarvis.example/api/admin/creation-asset-rehome", {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function pendingPreflight() {
  return {
    ready: false,
    vercel: { state: "pending", proofId: VERCEL_PROOF_ID, attempt: 1, expiresAt: 4_000_000_000_000 },
    trigger: { state: "pending", proofId: TRIGGER_PROOF_ID, attempt: 1, expiresAt: 4_000_000_000_000 },
  };
}

function readyPreflight() {
  return {
    ready: true,
    vercel: { state: "verified", proofId: VERCEL_PROOF_ID, attempt: 1, expiresAt: 4_000_000_000_000 },
    trigger: { state: "verified", proofId: TRIGGER_PROOF_ID, attempt: 1, expiresAt: 4_000_000_000_000 },
  };
}

describe("creation asset rehome control route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.isSameOriginRequest.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.isOwnerActor.mockReturnValue(true);
    mock.controlCredentials.mockReturnValue({ authTokenHash: "owner-session" });
    mock.privateCreationAssetStoreConfigurationCode.mockReturnValue("v2_vault_unavailable");
    mock.trigger.mockResolvedValue({ id: "trigger-run" });
  });

  it("fails before freezing V1 when Vercel cannot prove isolated V2 put/readback/delete", async () => {
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "creationAssetStoreMigration:beginPreflight") return pendingPreflight();
      if (path === "creationAssetStoreMigration:claimCapabilityProof") {
        return { ready: true, proofId: VERCEL_PROOF_ID, attempt: 1 };
      }
      if (path === "creationAssetStoreMigration:failCapabilityProof") return true;
      throw new Error(`unexpected mutation ${path}`);
    });
    mock.provePrivateCreationAssetV2Capability.mockRejectedValue(new Error("vault unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "isolated V2 creation storage is unavailable",
      code: "v2_vault_unavailable",
    });
    expect(mock.controlMutation.mock.calls.map(([path]) => path)).toEqual([
      "creationAssetStoreMigration:beginPreflight",
      "creationAssetStoreMigration:claimCapabilityProof",
      "creationAssetStoreMigration:failCapabilityProof",
    ]);
    expect(mock.controlMutation).not.toHaveBeenCalledWith("creationAssetStoreMigration:start", expect.anything());
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("does not freeze V1 until the opaque-id Trigger proof has independently completed", async () => {
    let begins = 0;
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "creationAssetStoreMigration:beginPreflight") {
        begins += 1;
        return begins === 1 ? pendingPreflight() : {
          ...pendingPreflight(),
          vercel: { ...pendingPreflight().vercel, state: "verified" },
        };
      }
      if (path === "creationAssetStoreMigration:claimCapabilityProof") {
        return { ready: true, proofId: VERCEL_PROOF_ID, attempt: 1 };
      }
      if (path === "creationAssetStoreMigration:verifyCapabilityProof") return { state: "verified" };
      throw new Error(`unexpected mutation ${path}`);
    });
    mock.controlQuery.mockResolvedValue(null);
    mock.provePrivateCreationAssetV2Capability.mockResolvedValue({ sha256: "a".repeat(64), sizeBytes: 72 });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      active: false,
      preflight: { ready: false, vercel: { state: "verified" }, trigger: { state: "pending" } },
      migration: { state: "not_started" },
    });
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-creation-asset-rehome-capability", { proofId: TRIGGER_PROOF_ID }, {
      idempotencyKey: `jarvis-creation-asset-capability-1-${TRIGGER_PROOF_ID}`,
    });
    expect(mock.controlMutation.mock.calls.map(([path]) => path)).not.toContain("creationAssetStoreMigration:start");
  });

  it("leaves Trigger proof pending when dispatch is unavailable instead of letting Vercel fail it", async () => {
    mock.controlMutation.mockResolvedValue({
      ...pendingPreflight(),
      vercel: { ...pendingPreflight().vercel, state: "verified" },
    });
    mock.controlQuery.mockResolvedValue(null);
    mock.trigger.mockRejectedValue(new Error("Trigger dispatch unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      active: false,
      preflight: { trigger: { state: "pending" } },
    });
    expect(mock.controlMutation.mock.calls.map(([path]) => path)).toEqual([
      "creationAssetStoreMigration:beginPreflight",
    ]);
    expect(mock.controlMutation.mock.calls.map(([path]) => path)).not.toContain("creationAssetStoreMigration:failCapabilityProof");
  });

  it("activates only after persisted proof, full verified cutover, and durable activation confirmation", async () => {
    let current = {
      state: "cutover_ready",
      attempt: 1,
      snapshotComplete: true,
      expectedCount: 1,
      verifiedCount: 1,
      cutoverCount: 0,
    };
    mock.controlQuery.mockImplementation(async (path: string) => {
      expect(path).toBe("creationAssetStoreMigration:status");
      return current;
    });
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "creationAssetStoreMigration:beginPreflight") return readyPreflight();
      if (path === "creationAssetStoreMigration:cutoverStep") {
        current = { ...current, state: "cutover", cutoverCount: 1 };
        return current;
      }
      if (path === "creationAssetStoreMigration:activate") return { activeStore: "private-r2-v2", ...current, state: "activated", activatedAt: 123 };
      if (path === "creationAssetStoreMigration:start") return current;
      throw new Error(`unexpected mutation ${path}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      active: "private-r2-v2",
      migration: { ...current, state: "activated", activatedAt: 123 },
    });
    expect(mock.controlMutation.mock.calls.map(([path]) => path)).toEqual([
      "creationAssetStoreMigration:beginPreflight",
      "creationAssetStoreMigration:start",
      "creationAssetStoreMigration:cutoverStep",
      "creationAssetStoreMigration:activate",
    ]);
    expect(mock.controlMutation).toHaveBeenLastCalledWith(
      "creationAssetStoreMigration:activate",
      { authTokenHash: "owner-session" },
    );
  });

  it("offers an owner-only abort path without touching V2 configuration or dispatching a worker", async () => {
    mock.controlMutation.mockImplementation(async (path: string) => {
      if (path === "creationAssetStoreMigration:abort") {
        return { state: "aborted", attempt: 1, snapshotComplete: false, expectedCount: 2, verifiedCount: 0, cutoverCount: 0, abortedAt: 123 };
      }
      throw new Error(`unexpected mutation ${path}`);
    });

    const response = await POST(request({ action: "abort", reason: "fix runtime provisioning" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, migration: { state: "aborted", attempt: 1, abortedAt: 123 } });
    expect(mock.controlMutation).toHaveBeenCalledWith("creationAssetStoreMigration:abort", {
      authTokenHash: "owner-session",
      reason: "fix runtime provisioning",
    });
    expect(mock.provePrivateCreationAssetV2Capability).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();
  });
});
