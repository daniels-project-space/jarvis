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
