import { describe, expect, it } from "vitest";
import { loadGitReviewReceiptAuthority } from "./git-review-authority";

describe("trusted Git review receipt authority", () => {
  it("loads the stable named controller-vault secret when a warm worker lacks an environment value", async () => {
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
  });

  it("fails closed for a missing or undersized authority", async () => {
    await expect(loadGitReviewReceiptAuthority({ environment: {} as NodeJS.ProcessEnv, loadVault: async () => ({}) })).resolves.toBeNull();
    await expect(loadGitReviewReceiptAuthority({ environment: { JARVIS_GIT_REVIEW_RECEIPT_SECRET: "short" } as unknown as NodeJS.ProcessEnv })).resolves.toBeNull();
  });
});
