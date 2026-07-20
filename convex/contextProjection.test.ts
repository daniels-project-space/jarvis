import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_BACKFILL_PAGE,
  backfillActive,
  refresh,
  remainingDirtySources,
  requestContextRefresh,
} from "./contextProjection";
import {
  ACTIVE_CONTEXT_LIMITS,
  BRAIN_ACTIVE_INDEX_VERSION,
  BRAIN_CONTEXT_VERSION,
} from "./brainContextModel";

function refreshHarness(initial: any = null) {
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
            const query = { eq: () => query };
            apply(query);
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
        return `scheduled-${schedules.length}`;
      },
    },
  };
  return { ctx, inserts, patches, schedules, getState: () => state };
}

function readyState(now: number, patch: Record<string, unknown> = {}) {
  return {
    _id: "refresh-state",
    key: "foreground",
    version: BRAIN_CONTEXT_VERSION,
    generation: 4,
    dirtySources: ["work"],
    requestedAt: now,
    scheduledAt: now,
    memoryComplete: true,
    memoryVersion: 1,
    activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
    activeIndexComplete: true,
    updatedAt: now,
    ...patch,
  };
}

describe("event-driven context projection refresh", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces source changes and bootstraps each scheduler exactly once", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-20T12:00:00.000Z");
    vi.setSystemTime(now);
    const cold = refreshHarness();

    await requestContextRefresh(cold.ctx, ["work"]);
    expect(cold.schedules.map(({ delay, args }) => ({ delay, args }))).toEqual([
      { delay: 400, args: { generation: 1 } },
      { delay: 0, args: { version: BRAIN_ACTIVE_INDEX_VERSION, source: "job", cursor: null } },
    ]);
    expect(cold.inserts).toHaveLength(1);
    expect(cold.getState().dirtySources).toEqual([
      "memory",
      "business",
      "projects",
      "work",
      "attention",
      "artifacts",
      "ui",
    ]);

    await requestContextRefresh(cold.ctx, ["work"]);
    expect(cold.schedules).toHaveLength(2);
    expect(cold.patches).toHaveLength(0);

    const steady = refreshHarness(readyState(now.getTime()));
    await requestContextRefresh(steady.ctx, ["attention"]);
    expect(steady.schedules).toHaveLength(0);
    expect(steady.getState().dirtySources).toEqual(["work", "attention"]);
    await requestContextRefresh(steady.ctx, ["attention"]);
    expect(steady.patches).toHaveLength(1);
  });

  it("re-arms lost refresh and active-backfill leases with fenced generations", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-20T12:00:00.000Z");
    vi.setSystemTime(now);
    const lostRefresh = refreshHarness(readyState(now.getTime(), {
      scheduledAt: now.getTime() - 60_001,
    }));
    await requestContextRefresh(lostRefresh.ctx, ["work"]);
    expect(lostRefresh.schedules).toHaveLength(1);
    expect(lostRefresh.schedules[0]).toMatchObject({ delay: 400, args: { generation: 5 } });
    expect(lostRefresh.getState().generation).toBe(5);

    const lostBackfill = refreshHarness(readyState(now.getTime(), {
      activeIndexComplete: false,
      activeBackfillSource: "mission",
      activeBackfillCursor: "cursor-32",
      activeBackfillScheduledAt: now.getTime() - 60_001,
      scheduledAt: undefined,
      dirtySources: ["work"],
    }));
    await requestContextRefresh(lostBackfill.ctx, ["work"]);
    expect(lostBackfill.schedules).toHaveLength(1);
    expect(lostBackfill.schedules[0]).toMatchObject({
      delay: 0,
      args: { version: BRAIN_ACTIVE_INDEX_VERSION, source: "mission", cursor: "cursor-32" },
    });
    expect(lostBackfill.getState().generation).toBe(4);
  });

  it("fences superseded refreshes and retains every unprocessed dirty source", async () => {
    const test = refreshHarness(readyState(Date.now(), { generation: 9 }));
    const handler = (refresh as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<any> })._handler;
    expect(await handler(test.ctx, { generation: 8 })).toEqual({ refreshed: false, reason: "superseded" });
    expect(test.patches).toHaveLength(0);
    expect(remainingDirtySources(["memory", "work", "attention"], ["memory", "work"]))
      .toEqual(["attention"]);
  });

  it("uses complete rank indexes after rollout and isolates the one legacy fan-out", () => {
    const source = readFileSync(new URL("./contextProjection.ts", import.meta.url), "utf8");
    const proactive = readFileSync(new URL("./proactive.ts", import.meta.url), "utf8");
    expect(source).toContain('withIndex("by_version_source_rank"');
    expect(source).toContain(".take(ACTIVE_CONTEXT_LIMITS[source])");
    expect(source).not.toContain('query("jobRuntime").withIndex("by_updatedAt").order("desc").take(32)');
    expect(source).not.toContain('query("missionRuntime").withIndex("by_createdAt").order("desc").take(16)');
    expect(source).not.toContain('query("projectGoals").withIndex("by_updatedAt").order("desc").take(32)');
    expect(source.match(/\.collect\(\)/g)).toHaveLength(1);
    expect(source.indexOf("async function loadLegacyAttention")).toBeLessThan(source.indexOf(".collect()"));
    expect(proactive).not.toContain(".collect()");
  });
});

type MigrationHarness = ReturnType<typeof activeMigrationHarness>;

function activeMigrationHarness() {
  const makeRows = (source: "job" | "mission" | "goal" | "attention") =>
    Array.from({ length: 41 }, (_, index) => {
      const common = {
        _id: `${source}-row-${index}`,
        createdAt: index + 1,
        updatedAt: index + 1,
        priority: index === 0 ? 100 : 10,
      };
      if (source === "job") {
        return { ...common, jobId: `job-${index}`, task: `job ${index}`, status: index === 40 ? "done" : "running", stage: "working", percent: 20, attempt: 1 };
      }
      if (source === "mission") {
        return { ...common, missionId: `mission-${index}`, goal: `mission ${index}`, mode: "goal", status: index === 40 ? "done" : "running", phase: "building", percent: 20 };
      }
      if (source === "goal") {
        return { ...common, project: "jarvis", title: `goal ${index}`, outcome: "reliable context", status: index === 40 ? "achieved" : "active", progress: 20 };
      }
      return {
        ...common,
        fingerprint: `attention-${index}`,
        title: `attention ${index}`,
        detail: "evidence",
        severity: "warning",
        impact: index === 0 ? 100 : 10,
        urgency: index === 0 ? 100 : 10,
        confidence: 1,
        actionClass: "inform",
        status: index === 40 ? "resolved" : "open",
      };
    });
  const rows: Record<string, any[]> = {
    jobRuntime: makeRows("job"),
    missionRuntime: makeRows("mission"),
    projectGoals: makeRows("goal"),
    attentionItems: makeRows("attention"),
  };
  let state: any = {
    _id: "refresh-state",
    key: "foreground",
    version: BRAIN_CONTEXT_VERSION,
    generation: 2,
    dirtySources: [],
    requestedAt: 1,
    memoryComplete: true,
    memoryVersion: 1,
    activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
    activeIndexComplete: false,
    activeBackfillSource: "job",
    activeBackfillScheduledAt: 1,
    updatedAt: 1,
  };
  const active = new Map<string, any>();
  const schedules: any[] = [];
  const pagination: any[] = [];
  let nextId = 1;

  const ctx = {
    db: {
      query(table: string) {
        const filters: Record<string, unknown> = {};
        const builder = {
          withIndex(_index: string, apply?: (q: any) => unknown) {
            const query = {
              eq(field: string, value: unknown) {
                filters[field] = value;
                return query;
              },
            };
            apply?.(query);
            return builder;
          },
          order(_direction: string) {
            return builder;
          },
          async first() {
            if (table === "brainContextRefresh") return state;
            if (table === "brainContextActive") return active.get(`${filters.source}:${filters.sourceId}`) ?? null;
            throw new Error(`Unexpected first() on ${table}`);
          },
          async paginate(options: any) {
            pagination.push({ table, ...options });
            const offset = Number(options.cursor ?? 0);
            const page = (rows[table] ?? []).slice(offset, offset + options.numItems);
            const next = offset + page.length;
            return {
              page,
              isDone: next >= (rows[table] ?? []).length,
              continueCursor: String(next),
            };
          },
        };
        return builder;
      },
      async insert(table: string, value: any) {
        if (table !== "brainContextActive") throw new Error(`Unexpected insert ${table}`);
        const id = `active-${nextId++}`;
        active.set(`${value.source}:${value.sourceId}`, { ...value, _id: id });
        return id;
      },
      async replace(id: string, value: any) {
        const entry = [...active.entries()].find(([, row]) => row._id === id);
        if (!entry) throw new Error(`Missing active row ${id}`);
        active.set(entry[0], { ...value, _id: id });
      },
      async delete(id: string) {
        const entry = [...active.entries()].find(([, row]) => row._id === id);
        if (entry) active.delete(entry[0]);
      },
      async patch(id: string, value: any) {
        if (id !== state._id) throw new Error(`Unexpected patch ${id}`);
        state = { ...state, ...value };
      },
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        schedules.push({ delay, reference, args });
        return `schedule-${schedules.length}`;
      },
    },
  };
  return { ctx, active, schedules, pagination, getState: () => state };
}

async function runActiveMigration(test: MigrationHarness) {
  const handler = (backfillActive as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<any> })._handler;
  let args: any = { version: BRAIN_ACTIVE_INDEX_VERSION, source: "job", cursor: null };
  const completionStates: boolean[] = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const scheduleStart = test.schedules.length;
    const result = await handler(test.ctx, args);
    completionStates.push(test.getState().activeIndexComplete === true);
    if (result.complete) return completionStates;
    const next = test.schedules.slice(scheduleStart).find((schedule) => schedule.args?.source);
    if (!next) throw new Error("Active migration did not schedule its continuation");
    args = next.args;
  }
  throw new Error("Active migration did not complete within the bounded test turns");
}

describe("active rank-index migration", () => {
  it("backfills every existing row in 32-document resumable pages before activating the version", async () => {
    const test = activeMigrationHarness();
    const completionStates = await runActiveMigration(test);

    expect(completionStates.slice(0, -1).every((complete) => !complete)).toBe(true);
    expect(completionStates.at(-1)).toBe(true);
    expect(test.pagination).toHaveLength(8);
    expect(test.pagination.every((page) =>
      page.numItems === ACTIVE_BACKFILL_PAGE && page.maximumRowsRead === ACTIVE_BACKFILL_PAGE,
    )).toBe(true);
    expect(test.active.size).toBe(160);
    expect(test.getState()).toMatchObject({
      activeIndexVersion: BRAIN_ACTIVE_INDEX_VERSION,
      activeIndexComplete: true,
      dirtySources: ["projects", "work", "attention"],
    });

    for (const source of ["job", "mission", "goal", "attention"] as const) {
      const ranked = [...test.active.values()]
        .filter((row) => row.source === source)
        .sort((left, right) => right.rank - left.rank || right.tieBreakAt - left.tieBreakAt)
        .slice(0, ACTIVE_CONTEXT_LIMITS[source]);
      const id = (index: number) => source === "job" || source === "mission"
        ? `${source}-${index}`
        : `${source}-row-${index}`;
      expect(ranked.map((row) => row.sourceId)).toEqual([
        id(0),
        ...Array.from(
          { length: ACTIVE_CONTEXT_LIMITS[source] - 1 },
          (_, index) => id(39 - index),
        ),
      ]);
    }
  });
});
