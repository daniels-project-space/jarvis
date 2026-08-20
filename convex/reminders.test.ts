import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "reminder-test-worker";
const SOURCE_KEY = "a".repeat(64);

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

describe("retry-safe timed reminders", () => {
  it("updates the one pending automated reminder instead of creating duplicate alerts", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.reminders.add, {
      text: "Download Seville map",
      at: 1_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });
    const retry = await t.mutation(api.reminders.add, {
      text: "Download Seville map after Gmail changed the departure",
      at: 2_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });

    expect(retry).toEqual(first);
    await expect(t.query(api.reminders.upcoming, { workerToken: WORKER })).resolves.toEqual([
      expect.objectContaining({ _id: first, text: "Download Seville map after Gmail changed the departure", at: 2_000 }),
    ]);
  });

  it("atomically refuses a protected source-key update after its cutoff", async () => {
    const t = convexTest(schema, modules);
    const initial = await t.mutation(api.reminders.add, {
      text: "Download Seville map",
      at: Date.now() + 60_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });

    await expect(t.mutation(api.reminders.add, {
      text: "Move the existing reminder after a delayed refresh",
      at: Date.now() + 120_000,
      sourceKey: SOURCE_KEY,
      sourceKeyUpdateCutoffAt: Date.now() - 1,
      workerToken: WORKER,
    })).rejects.toThrow("source_update_cutoff_passed");

    await expect(t.query(api.reminders.upcoming, { workerToken: WORKER })).resolves.toEqual([
      expect.objectContaining({ _id: initial, text: "Download Seville map" }),
    ]);
  });

  it("rejects arbitrary caller-defined reminder identities", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.reminders.add, {
      text: "bad source",
      at: 1_000,
      sourceKey: "not-a-digest",
      workerToken: WORKER,
    })).rejects.toThrow(/source key/i);
  });

  it("re-arms one completed automated reminder only when a reschedule is still in the future", async () => {
    const t = convexTest(schema, modules);
    const initial = await t.mutation(api.reminders.add, {
      text: "Download Seville map",
      at: Date.now() + 60_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });
    await t.mutation(api.reminders.complete, { id: initial, workerToken: WORKER });

    const rescheduled = await t.mutation(api.reminders.add, {
      text: "Download Seville map after flight moved",
      at: Date.now() + 120_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });
    expect(rescheduled).toEqual(initial);
    await expect(t.query(api.reminders.upcoming, { workerToken: WORKER })).resolves.toEqual([
      expect.objectContaining({ _id: initial, text: "Download Seville map after flight moved" }),
    ]);
  });

  it("never revives an automated reminder the owner cancelled", async () => {
    const t = convexTest(schema, modules);
    const initial = await t.mutation(api.reminders.add, {
      text: "Download Seville map",
      at: Date.now() + 60_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    });
    await expect(t.mutation(api.reminders.cancel, { match: "Seville", workerToken: WORKER })).resolves.toBe("Download Seville map");
    await expect(t.mutation(api.reminders.add, {
      text: "Download Seville map after flight moved",
      at: Date.now() + 120_000,
      sourceKey: SOURCE_KEY,
      workerToken: WORKER,
    })).resolves.toEqual(initial);
    await expect(t.query(api.reminders.upcoming, { workerToken: WORKER })).resolves.toEqual([]);
  });
});

describe("due reminder fairness", () => {
  it("reserves delivery capacity for due reminders while reclaiming a large stale backlog", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert("reminders", {
          text: `stale-${index}`,
          at: index,
          status: "delivering",
          deliverStartedAt: now - 10 * 60_000,
          deliveryAttempts: 1,
          createdAt: index,
        });
      }
      for (let index = 0; index < 50; index += 1) {
        await ctx.db.insert("reminders", {
          text: `pending-${index}`,
          at: now - 1,
          status: "pending",
          deliveryAttempts: 0,
          createdAt: index,
        });
      }
    });

    const claimed = await t.mutation(api.reminders.due, { workerToken: WORKER });

    expect(claimed).toHaveLength(50);
    expect(claimed.filter((row) => row.text.startsWith("pending-"))).toHaveLength(25);
    expect(claimed.filter((row) => row.text.startsWith("stale-"))).toHaveLength(25);
  });

  it("reclaims stale leases that are behind a full window of active deliveries", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 50; index += 1) {
        await ctx.db.insert("reminders", {
          text: `active-${index}`,
          at: index,
          status: "delivering",
          deliverStartedAt: now,
          deliveryAttempts: 1,
          createdAt: index,
        });
      }
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert("reminders", {
          text: `stale-behind-active-${index}`,
          at: 1_000 + index,
          status: "delivering",
          deliverStartedAt: now - 10 * 60_000,
          deliveryAttempts: 1,
          createdAt: 1_000 + index,
        });
      }
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert("reminders", {
          text: `pending-${index}`,
          at: now - 1,
          status: "pending",
          deliveryAttempts: 0,
          createdAt: 2_000 + index,
        });
      }
    });

    const claimed = await t.mutation(api.reminders.due, { workerToken: WORKER });

    expect(claimed).toHaveLength(50);
    expect(claimed.filter((row) => row.text.startsWith("pending-"))).toHaveLength(3);
    expect(claimed.filter((row) => row.text.startsWith("stale-behind-active-"))).toHaveLength(47);
    expect(claimed.map((row) => row.text)).toEqual(expect.arrayContaining([
      "pending-0",
      "pending-1",
      "pending-2",
      "stale-behind-active-0",
      "stale-behind-active-1",
      "stale-behind-active-2",
    ]));
    expect(claimed.some((row) => row.text.startsWith("active-"))).toBe(false);
  });

  it("still reclaims a legacy delivery that has no recorded lease timestamp", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("reminders", {
        text: "legacy-stale",
        at: 0,
        status: "delivering",
        deliveryAttempts: 1,
        createdAt: 0,
      });
    });

    await expect(t.mutation(api.reminders.due, { workerToken: WORKER })).resolves.toEqual([
      expect.objectContaining({ text: "legacy-stale" }),
    ]);
  });
});
