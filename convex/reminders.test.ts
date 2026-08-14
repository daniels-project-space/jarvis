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
});
