import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestContextRefresh } from "./contextProjection";

function harness(initial: any = null) {
  let state = initial;
  const inserts: any[] = [];
  const patches: any[] = [];
  const schedules: any[] = [];
  const ctx = {
    db: {
      query(table: string) {
        expect(table).toBe("brainContextRefresh");
        const builder = {
          withIndex(_index: string, apply: (q: any) => unknown) {
            apply({ eq: () => ({}) });
            return builder;
          },
          async first() {
            return state;
          },
        };
        return builder;
      },
      async insert(table: string, value: any) {
        expect(table).toBe("brainContextRefresh");
        inserts.push(value);
        state = { ...value, _id: "refresh-state" };
        return "refresh-state";
      },
      async patch(id: string, value: any) {
        expect(id).toBe("refresh-state");
        patches.push(value);
        state = { ...state, ...value };
      },
      async replace(id: string, value: any) {
        expect(id).toBe("refresh-state");
        state = { ...value, _id: id };
      },
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: unknown) {
        schedules.push({ delay, reference, args });
        return "scheduled-1";
      },
    },
  };
  return { ctx, inserts, patches, schedules, getState: () => state };
}

describe("event-driven context projection refresh", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces repeated source changes into one delayed rebuild", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    const test = harness();

    await requestContextRefresh(test.ctx, ["work"]);
    expect(test.schedules).toHaveLength(1);
    expect(test.inserts).toHaveLength(1);
    expect(test.getState().dirtySources).toEqual([
      "memory",
      "business",
      "projects",
      "work",
      "attention",
      "artifacts",
      "ui",
    ]);

    // The same heartbeat-derived source is already covered: no scheduler or
    // metadata write is added while the lease is healthy.
    await requestContextRefresh(test.ctx, ["work"]);
    expect(test.schedules).toHaveLength(1);
    expect(test.patches).toHaveLength(0);

    // A genuinely new source joins the same scheduled transaction rather than
    // creating another function invocation.
    test.getState().dirtySources = ["work"];
    await requestContextRefresh(test.ctx, ["attention"]);
    expect(test.schedules).toHaveLength(1);
    expect(test.patches).toHaveLength(1);
    expect(test.getState().dirtySources).toEqual(["work", "attention"]);
  });

  it("uses one bounded recency scan for work instead of five status scans", () => {
    const source = readFileSync(new URL("./contextProjection.ts", import.meta.url), "utf8");
    const jobQueries = source.match(/query\("jobRuntime"\)/g) ?? [];
    expect(jobQueries).toHaveLength(1);
    expect(source).toContain('query("jobRuntime").withIndex("by_updatedAt").order("desc").take(32)');
    expect(source).not.toContain("activeStatuses.map");
    expect(source).not.toContain("ctx.db.query(\"jobRuntime\").collect()");
  });
});
