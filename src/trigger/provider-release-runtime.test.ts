import { describe, expect, it, vi } from "vitest";
import { installDependenciesInPinnedCheckout } from "./provider-release-runtime";

describe("provider release pinned dependency install", () => {
  it("runs npm ci only between two exact source and cleanliness checks", async () => {
    const events: string[] = [];
    const verifyPinned = vi.fn(async (sha: string) => {
      events.push(`verify:${sha}`);
      return "/tmp/exact-checkout";
    });
    const runNpmCi = vi.fn(async (cwd: string) => { events.push(`npm-ci:${cwd}`); });
    const sha = "a".repeat(40);

    await expect(installDependenciesInPinnedCheckout({ sourceSha: sha, verifyPinned, runNpmCi }))
      .resolves.toBe("/tmp/exact-checkout");
    expect(events).toEqual([
      `verify:${sha}`,
      "npm-ci:/tmp/exact-checkout",
      `verify:${sha}`,
    ]);
  });

  it("fails closed when dependency installation changes checkout identity", async () => {
    const verifyPinned = vi.fn()
      .mockResolvedValueOnce("/tmp/exact-checkout")
      .mockResolvedValueOnce("/tmp/replaced-checkout");
    await expect(installDependenciesInPinnedCheckout({
      sourceSha: "b".repeat(40),
      verifyPinned,
      runNpmCi: async () => undefined,
    })).rejects.toThrow("changed the pinned checkout identity");
  });
});
