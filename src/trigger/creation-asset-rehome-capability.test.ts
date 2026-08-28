import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
}));
vi.mock("../lib/private-creation-asset-store", () => ({
  provePrivateCreationAssetV2Capability: vi.fn(),
}));

import { proveCreationAssetV2Capability } from "./creation-asset-rehome-capability";

const PROOF_ID = "j57d9dbxe9b31fkrbkk7pg2h7n7caa3u";

describe("creation asset V2 capability task", () => {
  beforeEach(() => vi.clearAllMocks());

  it("receives only the opaque proof id and persists Trigger's independent readback proof", async () => {
    const call = vi.fn(async (_kind: string, path: string) => {
      if (path === "creationAssetStoreMigration:claimCapabilityProof") {
        return { ready: true, proofId: PROOF_ID, attempt: 7 };
      }
      if (path === "creationAssetStoreMigration:verifyCapabilityProof") return { state: "verified" };
      throw new Error(`unexpected Convex call ${path}`);
    });
    const prove = vi.fn(async () => ({ sha256: "e".repeat(64), sizeBytes: 71 }));

    await expect(proveCreationAssetV2Capability(PROOF_ID, { call: call as any, prove: prove as any }))
      .resolves.toEqual({ proofId: PROOF_ID, verified: true, sha256: "e".repeat(64), sizeBytes: 71 });

    expect(call).toHaveBeenNthCalledWith(1, "mutation", "creationAssetStoreMigration:claimCapabilityProof", {
      proofId: PROOF_ID,
      runtime: "trigger",
    });
    expect(prove).toHaveBeenCalledWith(PROOF_ID);
    expect(call).toHaveBeenLastCalledWith("mutation", "creationAssetStoreMigration:verifyCapabilityProof", {
      proofId: PROOF_ID,
      runtime: "trigger",
      attempt: 7,
      sha256: "e".repeat(64),
      sizeBytes: 71,
    });
    expect(JSON.stringify(call.mock.calls)).not.toContain("assetLocator");
    expect(JSON.stringify(call.mock.calls)).not.toContain("assetStore");
  });

  it("records a sanitized failed proof and never claims V2 success when Trigger's runtime capability fails", async () => {
    const call = vi.fn(async (_kind: string, path: string) => {
      if (path === "creationAssetStoreMigration:claimCapabilityProof") {
        return { ready: true, proofId: PROOF_ID, attempt: 3 };
      }
      if (path === "creationAssetStoreMigration:failCapabilityProof") return true;
      throw new Error(`unexpected Convex call ${path}`);
    });
    const prove = vi.fn(async () => { throw new Error("Trigger vault selector unreadable: secret-value"); });

    await expect(proveCreationAssetV2Capability(PROOF_ID, { call: call as any, prove: prove as any }))
      .rejects.toThrow("Trigger vault selector unreadable");
    expect(call).toHaveBeenLastCalledWith("mutation", "creationAssetStoreMigration:failCapabilityProof", {
      proofId: PROOF_ID,
      runtime: "trigger",
      attempt: 3,
      reason: "Trigger V2 capability proof failed",
    });
    expect(JSON.stringify(call.mock.calls)).not.toContain("secret-value");
  });

  it("does not invoke a storage primitive for an expired or already-consumed proof", async () => {
    const call = vi.fn(async () => ({ ready: false, inactive: true }));
    const prove = vi.fn();

    await expect(proveCreationAssetV2Capability(PROOF_ID, { call: call as any, prove: prove as any }))
      .resolves.toMatchObject({ proofId: PROOF_ID, skipped: true, inactive: true });
    expect(prove).not.toHaveBeenCalled();
  });
});
