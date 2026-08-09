import { afterEach, describe, expect, it, vi } from "vitest";
import { adminSessionStatus } from "./control-session";

describe("owner session status classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("distinguishes a temporary Convex outage from an invalid owner session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    await expect(adminSessionStatus("a".repeat(64))).resolves.toEqual({
      valid: false,
      unavailable: true,
    });
  });

  it("treats a successful negative lookup as genuinely invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: { valid: false } }))));
    await expect(adminSessionStatus("b".repeat(64))).resolves.toEqual({ valid: false });
  });

  it("returns the validated durable expiry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: { valid: true, expiresAt: 123_456 },
    }))));
    await expect(adminSessionStatus("c".repeat(64))).resolves.toEqual({
      valid: true,
      expiresAt: 123_456,
    });
  });
});
