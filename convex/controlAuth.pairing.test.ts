import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "pairing-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

describe("owner pairing capabilities", () => {
  it("atomically consumes a pairing ticket once", async () => {
    const t = convexTest(schema, modules);
    const tokenHash = "a".repeat(64);
    const ownerTokenHash = "b".repeat(64);
    await t.mutation(api.controlAuth.createOwnerPairingTicket, {
      tokenHash,
      expiresAt: Date.now() + 10 * 60_000,
      workerToken: WORKER,
    });
    await expect(t.mutation(api.controlAuth.consumeOwnerPairingTicket, {
      tokenHash,
      ownerTokenHash,
      userAgent: "Daniel browser",
    })).resolves.toMatchObject({ expiresAt: expect.any(Number) });
    await expect(t.mutation(api.controlAuth.consumeOwnerPairingTicket, {
      tokenHash,
      ownerTokenHash: "c".repeat(64),
    })).resolves.toBe(false);
    await expect(t.query(api.controlAuth.validateSession, { tokenHash: ownerTokenHash })).resolves.toBe(true);
  });

  it("rejects expired tickets and binds embed control to one trusted host string", async () => {
    const t = convexTest(schema, modules);
    const ticketHash = "d".repeat(64);
    const ownerTokenHash = "e".repeat(64);
    await t.mutation(api.controlAuth.createOwnerPairingTicket, {
      tokenHash: ticketHash,
      expiresAt: Date.now() + 60_000,
      workerToken: WORKER,
    });
    vi.advanceTimersByTime(60_001);
    await expect(t.mutation(api.controlAuth.consumeOwnerPairingTicket, {
      tokenHash: ticketHash,
      ownerTokenHash,
    })).resolves.toBe(false);

    const liveTicket = "f".repeat(64);
    await t.mutation(api.controlAuth.createOwnerPairingTicket, {
      tokenHash: liveTicket,
      expiresAt: Date.now() + 60_000,
      workerToken: WORKER,
    });
    await t.mutation(api.controlAuth.consumeOwnerPairingTicket, { tokenHash: liveTicket, ownerTokenHash });
    const embedHash = "1".repeat(64);
    await t.mutation(api.controlAuth.createEmbedControlSession, {
      authTokenHash: ownerTokenHash,
      tokenHash: embedHash,
      hostOrigin: "https://project-hub-olive-pi.vercel.app",
      expiresAt: Date.now() + 60_000,
    });
    await expect(t.query(api.controlAuth.embedControlSessionStatus, {
      tokenHash: embedHash,
      hostOrigin: "https://project-hub-olive-pi.vercel.app",
    })).resolves.toMatchObject({ valid: true, authTokenHash: ownerTokenHash });
    await expect(t.query(api.controlAuth.embedControlSessionStatus, {
      tokenHash: embedHash,
      hostOrigin: "https://evil.example",
    })).resolves.toEqual({ valid: false });
  });
});
