import { describe, expect, it } from "vitest";
import {
  gitReviewReceiptAuthorityHealth,
  loadGitReviewReceiptAuthority,
  repositoryDeliveryReadiness,
  verifyGitReviewReceiptEnvelope,
} from "./git-review-authority";
import { createGitReviewReceiptKeyring } from "./git-review-receipt";

const receipt = {
  version: 1, jobId: "job", attempt: 1, repository: "daniels-project-space/jarvis", branch: "jarvis/test",
  baseSha: "a".repeat(40), baseTreeSha: "b".repeat(40), headSha: "c".repeat(40), headTreeSha: "d".repeat(40),
  parentShas: [], historyComplete: true, baseIsAncestor: true, commitCount: 1, commits: "", clean: true,
  diffStat: "", changedPaths: "", diffPatch: "", diffSha256: "e".repeat(64), diffChars: 0,
  agentEvidenceSha256: "f".repeat(64), commands: [],
} as const;
const binding = {
  jobId: receipt.jobId, attempt: receipt.attempt, repository: receipt.repository, branch: receipt.branch,
  baseSha: receipt.baseSha, headSha: receipt.headSha, agentEvidenceSha256: receipt.agentEvidenceSha256,
};

describe("trusted Git review receipt authority", () => {
  it("loads the legacy verifier for migration but does not treat it as delivery-ready", async () => {
    let calls = 0;
    const authority = await loadGitReviewReceiptAuthority({
      environment: {} as NodeJS.ProcessEnv,
      loadVault: async (service) => {
        calls += 1;
        expect(service).toBe("jarvis");
        return { JARVIS_GIT_REVIEW_RECEIPT_SECRET: "v".repeat(32) };
      },
    });
    expect(authority).not.toBeNull();
    expect(calls).toBe(1);
    expect(repositoryDeliveryReadiness(true, authority)).toEqual({
      ready: false, reason: "rotating controller receipt signer unavailable",
    });
  });

  it("fails closed for a missing or undersized authority", async () => {
    await expect(loadGitReviewReceiptAuthority({ environment: {} as NodeJS.ProcessEnv, loadVault: async () => ({}) })).resolves.toBeNull();
    await expect(loadGitReviewReceiptAuthority({ environment: { JARVIS_GIT_REVIEW_RECEIPT_SECRET: "short" } as unknown as NodeJS.ProcessEnv })).resolves.toBeNull();
  });

  it("signs with the current public id, verifies explicit previous ids, and rejects unknown or retired ids", async () => {
    const old = createGitReviewReceiptKeyring({ keyId: "old", secret: "o".repeat(32) });
    const oldEnvelope = old.issue(receipt);
    const rotating = createGitReviewReceiptKeyring(
      { keyId: "current", secret: "c".repeat(32) },
      [{ keyId: "old", secret: "o".repeat(32) }],
    );
    expect(rotating.issue(receipt).keyId).toBe("current");
    expect(rotating.verify(oldEnvelope, binding)).toBe(true);
    expect(createGitReviewReceiptKeyring({ keyId: "current", secret: "c".repeat(32) }).verify(oldEnvelope, binding)).toBe(false);
    expect(rotating.verify({ ...oldEnvelope, keyId: "unknown" }, binding)).toBe(false);
  });

  it("reloads configuration once for turnover and then fails closed", async () => {
    const envelope = createGitReviewReceiptKeyring({ keyId: "next", secret: "n".repeat(32) }).issue(receipt);
    let calls = 0;
    const verified = await verifyGitReviewReceiptEnvelope(envelope, binding, {
      environment: {} as NodeJS.ProcessEnv,
      loadVault: async () => {
        calls += 1;
        return { JARVIS_GIT_REVIEW_RECEIPT_KEYRING: JSON.stringify({
          current: calls === 1
            ? { keyId: "current", secret: "c".repeat(32) }
            : { keyId: "next", secret: "n".repeat(32) },
          previous: [],
        }) };
      },
    });
    expect(verified).toBe(true);
    expect(calls).toBe(2);

    calls = 0;
    expect(await verifyGitReviewReceiptEnvelope({ ...envelope, keyId: "retired" }, binding, {
      environment: {} as NodeJS.ProcessEnv,
      loadVault: async () => {
        calls += 1;
        return { JARVIS_GIT_REVIEW_RECEIPT_KEYRING: JSON.stringify({ current: { keyId: "next", secret: "n".repeat(32) }, previous: [] }) };
      },
    })).toBe(false);
    expect(calls).toBe(2);
  });

  it("exposes only a secret-free readiness signal for release preflight", async () => {
    await expect(gitReviewReceiptAuthorityHealth({
      environment: {} as NodeJS.ProcessEnv,
      loadVault: async () => ({}),
    })).resolves.toEqual({ ready: false, reason: "rotating controller receipt signer unavailable" });
    expect(repositoryDeliveryReadiness(true, null)).toEqual({ ready: false, reason: "rotating controller receipt signer unavailable" });
    await expect(gitReviewReceiptAuthorityHealth({
      environment: { JARVIS_GIT_REVIEW_RECEIPT_KEYRING: JSON.stringify({
        current: { keyId: "current", secret: "c".repeat(32) }, previous: [],
      }) } as unknown as NodeJS.ProcessEnv,
    })).resolves.toEqual({ ready: true, reason: "ready" });
  });
});
