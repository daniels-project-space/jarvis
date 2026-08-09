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

  it("recovers the real Sevilla guest history and state exactly once", async () => {
    const t = convexTest(schema, modules);
    const ticketHash = "2".repeat(64);
    const ownerTokenHash = "3".repeat(64);
    const guestId = "4".repeat(32);
    await t.mutation(api.controlAuth.createOwnerPairingTicket, {
      tokenHash: ticketHash,
      expiresAt: Date.now() + 60_000,
      workerToken: WORKER,
    });
    await t.mutation(api.controlAuth.consumeOwnerPairingTicket, { tokenHash: ticketHash, ownerTokenHash });
    await t.run(async (ctx) => {
      await ctx.db.insert("chatMessages", {
        threadId: `guest:${guestId}`,
        role: "user",
        text: "I'm in Sevilla right now, can you show me a map with some attractions in the city?",
        status: "pending",
        delivery: "foreground",
        createdAt: Date.now() - 1_000,
      });
      await ctx.db.insert("chatMessages", {
        threadId: `guest:${guestId}`,
        role: "assistant",
        text: "I can’t display a live map here.",
        status: "done",
        delivery: "foreground",
        createdAt: Date.now(),
      });
    });

    await expect(t.mutation(api.guestMigration.recoverGuestConversation, {
      authTokenHash: ownerTokenHash,
      guestId,
    })).resolves.toEqual({ migratedMessages: 2, migratedLegacyRows: 0 });
    const recovered = await t.run(async (ctx) => ({
      main: await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", "main")).collect(),
      guest: await ctx.db.query("chatMessages").withIndex("by_thread", (q) => q.eq("threadId", `guest:${guestId}`)).collect(),
      state: await ctx.db.query("currentState").withIndex("by_key", (q) => q.eq("key", "profile.current_location")).first(),
    }));
    expect(recovered.main).toHaveLength(2);
    expect(recovered.main.find((row) => row.role === "user")?.status).toBe("error");
    expect(recovered.guest).toEqual([]);
    expect(recovered.state).toMatchObject({ value: "Sevilla" });
    await expect(t.mutation(api.guestMigration.recoverGuestConversation, {
      authTokenHash: ownerTokenHash,
      guestId,
    })).resolves.toEqual({ migratedMessages: 0, migratedLegacyRows: 0 });
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
      workerToken: "wrong-worker-token",
    })).rejects.toThrow(/Unauthorized worker capability/i);
    await expect(t.query(api.controlAuth.embedControlSessionStatus, {
      tokenHash: embedHash,
      hostOrigin: "https://project-hub-olive-pi.vercel.app",
      workerToken: WORKER,
    })).resolves.toMatchObject({ valid: true, authTokenHash: ownerTokenHash });
    await expect(t.query(api.controlAuth.embedControlSessionStatus, {
      tokenHash: embedHash,
      hostOrigin: "https://evil.example",
      workerToken: WORKER,
    })).resolves.toEqual({ valid: false });
  });
});
