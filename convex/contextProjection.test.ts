import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_BACKFILL_PAGE,
  backfillActive,
  bootstrap,
  refresh,
  remainingDirtySources,
  requestContextRefresh,
  syncContextActiveRow,
} from "./contextProjection";
import {
  ACTIVE_CONTEXT_LIMITS,
  BRAIN_ACTIVE_INDEX_VERSION,
  BRAIN_CONTEXT_VERSION,
  emptyBrainContext,
  estimateJsonBytes,
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

function bootstrapHarness(attentionRows: any[], existing: any = null) {
  let state: any = null;
  const reads: string[] = [];
  const writes: Array<{ operation: string; table: string; value: any }> = [];
  const schedules: Array<{ delay: number; args: any }> = [];
  const ctx = {
    db: {
      query(table: string) {
        reads.push(table);
        if (table === "attentionItems") {
          throw new Error(`Bootstrap scanned ${attentionRows.length} attention rows`);
        }
        const builder = {
          withIndex(_index: string, apply?: (q: any) => unknown) {
            const query = { eq: () => query };
            apply?.(query);
            return builder;
          },
          async first() {
            if (table === "brainContextProjection") return existing;
            if (table === "brainContextRefresh") return state;
            throw new Error(`Unexpected bootstrap read ${table}`);
          },
        };
        return builder;
      },
      async insert(table: string, value: any) {
        writes.push({ operation: "insert", table, value });
        if (table !== "brainContextRefresh") throw new Error(`Unexpected bootstrap insert ${table}`);
        state = { ...value, _id: "refresh-state" };
        return state._id;
      },
      async patch(id: string, value: any) {
        writes.push({ operation: "patch", table: "brainContextRefresh", value });
        if (id !== state?._id) throw new Error(`Unexpected bootstrap patch ${id}`);
        state = { ...state, ...value };
      },
    },
    scheduler: {
      async runAfter(delay: number, _reference: unknown, args: any) {
        schedules.push({ delay, args });
        return `schedule-${schedules.length}`;
      },
    },
  };
  return { ctx, reads, writes, schedules, getState: () => state };
}

describe("event-driven context projection refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("coalesces source changes and bootstraps each scheduler exactly once", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-20T12:00:00.000Z");
    vi.setSystemTime(now);
    const cold = refreshHarness();

    await requestContextRefresh(cold.ctx, ["work"]);
    expect(cold.schedules.map(({ delay, args }) => ({ delay, args }))).toEqual([
      {
        delay: 0,
        args: {
          version: BRAIN_ACTIVE_INDEX_VERSION,
          generation: 1,
          phase: "source",
          source: "job",
          cursor: null,
        },
      },
      { delay: 400, args: { generation: 1 } },
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
      activeBackfillGeneration: 7,
      activeBackfillPhase: "source",
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
      args: {
        version: BRAIN_ACTIVE_INDEX_VERSION,
        generation: 8,
        phase: "source",
        source: "mission",
        cursor: "cursor-32",
      },
    });
    expect(lostBackfill.getState().generation).toBe(4);
    expect(lostBackfill.getState().activeBackfillGeneration).toBe(8);
  });

  it("fences superseded refreshes and retains every unprocessed dirty source", async () => {
    const test = refreshHarness(readyState(Date.now(), { generation: 9 }));
    const handler = (refresh as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<any> })._handler;
    expect(await handler(test.ctx, { generation: 8 })).toEqual({ refreshed: false, reason: "superseded" });
    expect(test.patches).toHaveLength(0);
    expect(remainingDirtySources(["memory", "work", "attention"], ["memory", "work"]))
      .toEqual(["attention"]);
  });

  it("uses complete rank indexes and permits zero operational collection scans", () => {
    const source = readFileSync(new URL("./contextProjection.ts", import.meta.url), "utf8");
    const proactive = readFileSync(new URL("./proactive.ts", import.meta.url), "utf8");
    expect(source).toContain('withIndex("by_version_source_rank"');
    expect(source).toContain(".take(ACTIVE_CONTEXT_LIMITS[source])");
    expect(source).not.toContain('query("jobRuntime").withIndex("by_updatedAt").order("desc").take(32)');
    expect(source).not.toContain('query("missionRuntime").withIndex("by_createdAt").order("desc").take(16)');
    expect(source).not.toContain('query("projectGoals").withIndex("by_updatedAt").order("desc").take(32)');
    expect(source).not.toContain(".collect()");
    expect(source).not.toContain("loadLegacyAttention");
    expect(proactive).not.toContain(".collect()");
  });

  it("bootstraps a transaction-sized attention fixture with singleton work and returns prior last-known-good", async () => {
    const workerToken = "context-bootstrap-test-worker";
    vi.stubEnv("JARVIS_WORKER_TOKEN", workerToken);
    const attentionRows = Array.from({ length: 50_000 }, (_, index) => ({ _id: `attention-${index}` }));
    const payload = emptyBrainContext(123);
    payload.attention = [{ id: "prior-attention", title: "Prior complete context", status: "open" }];
    const prior = {
      _id: "projection-prior",
      key: "foreground",
      version: BRAIN_CONTEXT_VERSION - 1,
      payload,
      payloadBytes: estimateJsonBytes(payload),
      generatedAt: 123,
    };
    const test = bootstrapHarness(attentionRows, prior);
    const handler = (bootstrap as unknown as {
      _handler: (ctx: unknown, args: unknown) => Promise<any>;
    })._handler;

    const result = await handler(test.ctx, { workerToken });

    expect(test.reads).toEqual([
      "brainContextProjection",
      "brainContextRefresh",
      "brainContextRefresh",
    ]);
    expect(test.writes.map(({ operation, table }) => ({ operation, table }))).toEqual([
      { operation: "insert", table: "brainContextRefresh" },
      { operation: "patch", table: "brainContextRefresh" },
    ]);
    expect(test.schedules).toHaveLength(3);
    expect(test.schedules[0]).toMatchObject({
      delay: 0,
      args: {
        version: BRAIN_ACTIVE_INDEX_VERSION,
        generation: 1,
        phase: "source",
        source: "job",
        cursor: null,
      },
    });
    expect(test.getState()).toMatchObject({
      activeIndexComplete: false,
      activeBackfillGeneration: 1,
      activeBackfillPhase: "source",
      activeBackfillSource: "job",
    });
    expect(result.attention).toEqual(payload.attention);
    expect(result.projection).toMatchObject({
      state: "migrating",
      version: BRAIN_CONTEXT_VERSION - 1,
      activeIndexComplete: false,
    });
  });

  it("returns an honest empty migrating DTO on a true cold bootstrap", async () => {
    const workerToken = "context-cold-bootstrap-test-worker";
    vi.stubEnv("JARVIS_WORKER_TOKEN", workerToken);
    const test = bootstrapHarness(Array.from({ length: 40_000 }, (_, index) => ({ _id: `row-${index}` })));
    const handler = (bootstrap as unknown as {
      _handler: (ctx: unknown, args: unknown) => Promise<any>;
    })._handler;

    const result = await handler(test.ctx, { workerToken });

    expect(result).toMatchObject({
      memory: [],
      projects: [],
      jobs: [],
      attention: [],
      projection: {
        state: "migrating",
        version: 0,
        generatedAt: 0,
        activeIndexComplete: false,
      },
    });
    expect(test.reads).not.toContain("attentionItems");
    expect(test.schedules[0].args).toMatchObject({ phase: "source", source: "job", cursor: null });
  });
});

type MigrationSeed = {
  rows: Record<string, any[]>;
  state: any;
  active: any[];
  nextId: number;
  revision: number;
};

type MigrationHarness = ReturnType<typeof activeMigrationHarness>;

function makeSourceRows(source: "job" | "mission" | "goal" | "attention") {
  return Array.from({ length: 41 }, (_, index) => {
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
}

function compareKeys(left: readonly (string | number)[], right: readonly (string | number)[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function activeMigrationHarness(seed?: MigrationSeed) {
  const rows: Record<string, any[]> = structuredClone(seed?.rows ?? {
    jobRuntime: makeSourceRows("job"),
    missionRuntime: makeSourceRows("mission"),
    projectGoals: makeSourceRows("goal"),
    attentionItems: makeSourceRows("attention"),
  });
  let state: any = structuredClone(seed?.state ?? {
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
    activeBackfillGeneration: 1,
    activeBackfillPhase: "source",
    activeBackfillSource: "job",
    activeBackfillScheduledAt: 1,
    updatedAt: 1,
  });
  const active = new Map<string, any>(
    structuredClone(seed?.active ?? []).map((row: any) => [String(row._id), row]),
  );
  const schedules: any[] = [];
  const pagination: any[] = [];
  let nextId = seed?.nextId ?? 1;
  let revision = seed?.revision ?? 1;

  const keyFor = (table: string, row: any, index: string) => {
    if (table === "brainContextActive" && index === "by_source_id") {
      return [String(row.source), String(row.sourceId), Number(row._creationTime ?? 0), String(row._id)];
    }
    return [Number(row.createdAt ?? 0), String(row._id)];
  };

  const ctx = {
    db: {
      query(table: string) {
        const filters: Record<string, unknown> = {};
        let index = "";
        let direction = "asc";
        const matching = () => {
          let values = table === "brainContextActive"
            ? [...active.values()]
            : [...(rows[table] ?? [])];
          values = values.filter((row) => Object.entries(filters).every(([field, value]) => row[field] === value));
          values.sort((left, right) => compareKeys(keyFor(table, left, index), keyFor(table, right, index)));
          return direction === "desc" ? values.reverse() : values;
        };
        const builder = {
          withIndex(name: string, apply?: (q: any) => unknown) {
            index = name;
            const query = {
              eq(field: string, value: unknown) {
                filters[field] = value;
                return query;
              },
            };
            apply?.(query);
            return builder;
          },
          order(value: string) {
            direction = value;
            return builder;
          },
          async first() {
            if (table === "brainContextRefresh") return state;
            return matching()[0] ?? null;
          },
          async take(limit: number) {
            return matching().slice(0, limit);
          },
          async paginate(options: any) {
            pagination.push({ table, index, ...options });
            const values = matching();
            const cursorKey = options.cursor ? JSON.parse(options.cursor) : null;
            const remaining = cursorKey
              ? values.filter((row) => compareKeys(keyFor(table, row, index), cursorKey) > 0)
              : values;
            const page = remaining.slice(0, options.numItems);
            const continueCursor = page.length
              ? JSON.stringify(keyFor(table, page.at(-1), index))
              : options.cursor ?? JSON.stringify([]);
            return {
              page,
              isDone: remaining.length <= page.length,
              continueCursor,
            };
          },
        };
        return builder;
      },
      normalizeId(_table: string, value: string) {
        return value;
      },
      async get(id: string) {
        if (active.has(String(id))) return active.get(String(id));
        for (const values of Object.values(rows)) {
          const row = values.find((item) => String(item._id) === String(id));
          if (row) return row;
        }
        return null;
      },
      async insert(table: string, value: any) {
        if (table !== "brainContextActive") throw new Error(`Unexpected insert ${table}`);
        const id = `active-${nextId++}`;
        active.set(id, { ...value, _id: id, _creationTime: nextId });
        revision += 1;
        return id;
      },
      async replace(id: string, value: any) {
        const prior = active.get(String(id));
        if (!prior) throw new Error(`Missing active row ${id}`);
        active.set(String(id), { ...value, _id: id, _creationTime: prior._creationTime });
        revision += 1;
      },
      async delete(id: string) {
        if (active.delete(String(id))) revision += 1;
      },
      async patch(id: string, value: any) {
        if (id !== state._id) throw new Error(`Unexpected patch ${id}`);
        state = { ...state, ...value };
        revision += 1;
      },
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        schedules.push({ delay, reference, args });
        return `schedule-${schedules.length}`;
      },
    },
  };

  const snapshot = (): MigrationSeed => ({
    rows: structuredClone(rows),
    state: structuredClone(state),
    active: structuredClone([...active.values()]),
    nextId,
    revision,
  });
  const updateSource = (table: string, id: string, patch: Record<string, unknown>) => {
    const index = rows[table].findIndex((row) => String(row._id) === id);
    if (index < 0) throw new Error(`Missing source ${table}:${id}`);
    rows[table][index] = { ...rows[table][index], ...patch };
    revision += 1;
    return rows[table][index];
  };
  const deleteSource = (table: string, id: string) => {
    const before = rows[table].length;
    rows[table] = rows[table].filter((row) => String(row._id) !== id);
    if (rows[table].length !== before) revision += 1;
  };
  const addActive = (value: any) => {
    const id = value._id ?? `active-${nextId++}`;
    active.set(String(id), { ...value, _id: id, _creationTime: value._creationTime ?? nextId });
    revision += 1;
    return id;
  };
  return {
    ctx,
    active,
    rows,
    schedules,
    pagination,
    getState: () => state,
    snapshot,
    fork: () => activeMigrationHarness(snapshot()),
    revision: () => revision,
    updateSource,
    deleteSource,
    addActive,
    transactionCanCommit: (baseRevision: number) => revision === baseRevision,
  };
}

const activeHandler = (backfillActive as unknown as {
  _handler: (ctx: unknown, args: unknown) => Promise<any>;
})._handler;

function migrationArgs(test: MigrationHarness) {
  const state = test.getState();
  return {
    version: BRAIN_ACTIVE_INDEX_VERSION,
    generation: state.activeBackfillGeneration,
    phase: state.activeBackfillPhase,
    source: state.activeBackfillSource,
    cursor: state.activeBackfillCursor ?? null,
  };
}

async function runActiveMigration(test: MigrationHarness) {
  const completionStates: boolean[] = [];
  for (let turn = 0; turn < 30; turn += 1) {
    const scheduleStart = test.schedules.length;
    const result = await activeHandler(test.ctx, migrationArgs(test));
    completionStates.push(test.getState().activeIndexComplete === true);
    if (result.complete) return completionStates;
    const continuation = test.schedules.slice(scheduleStart).find((schedule) =>
      schedule.args?.version === BRAIN_ACTIVE_INDEX_VERSION && schedule.args?.phase,
    );
    if (!continuation) throw new Error("Active migration did not schedule its continuation");
    expect(continuation.args).toEqual(migrationArgs(test));
  }
  throw new Error("Active migration did not complete within the bounded test turns");
}

async function runUntilCleanup(test: MigrationHarness) {
  for (let turn = 0; turn < 20 && test.getState().activeBackfillPhase !== "cleanup"; turn += 1) {
    await activeHandler(test.ctx, migrationArgs(test));
  }
  expect(test.getState().activeBackfillPhase).toBe("cleanup");
}

describe("active rank-index migration", () => {
  it("rejects an abandoned generation before it can read or write a page", async () => {
    const test = activeMigrationHarness();
    const result = await activeHandler(test.ctx, {
      ...migrationArgs(test),
      generation: test.getState().activeBackfillGeneration - 1,
    });

    expect(result).toEqual({ complete: false, reason: "superseded" });
    expect(test.pagination).toHaveLength(0);
    expect(test.active.size).toBe(0);
  });

  it("backfills every existing row in 32-document resumable pages and cleans before activating", async () => {
    const test = activeMigrationHarness();
    const completionStates = await runActiveMigration(test);

    expect(completionStates.slice(0, -1).every((complete) => !complete)).toBe(true);
    expect(completionStates.at(-1)).toBe(true);
    expect(test.pagination).toHaveLength(13);
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
        ...Array.from({ length: ACTIVE_CONTEXT_LIMITS[source] - 1 }, (_, index) => id(39 - index)),
      ]);
    }
  });

  it("retries a rank-changing writer interleaving from a discarded transaction snapshot", async () => {
    const test = activeMigrationHarness();
    const baseRevision = test.revision();
    const attemptedPage = test.fork();
    await activeHandler(attemptedPage.ctx, migrationArgs(attemptedPage));
    expect([...attemptedPage.active.values()].find((row) => row.sourceId === "job-1")?.rank).toBe(10);
    expect(test.active.size).toBe(0);

    const newest = test.updateSource("jobRuntime", "job-row-1", { priority: 99, updatedAt: 500 });
    await syncContextActiveRow(test.ctx, "job", newest);
    await requestContextRefresh(test.ctx, ["work"]);
    expect(test.transactionCanCommit(baseRevision)).toBe(false);

    // Convex retries the whole conflicting page transaction; none of the fork's
    // writes or scheduled continuations are committed.
    await activeHandler(test.ctx, migrationArgs(test));
    const indexed = [...test.active.values()].filter((row) => row.sourceId === "job-1");
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      version: BRAIN_ACTIVE_INDEX_VERSION,
      rank: 99,
      sourceUpdatedAt: 500,
    });
  });

  it("does not resurrect a row resolved or deleted while its source page attempt is in flight", async () => {
    const test = activeMigrationHarness();
    while (test.getState().activeBackfillSource !== "attention") {
      await activeHandler(test.ctx, migrationArgs(test));
    }
    const baseRevision = test.revision();
    const attemptedPage = test.fork();
    await activeHandler(attemptedPage.ctx, migrationArgs(attemptedPage));
    expect([...attemptedPage.active.values()].some((row) => row.sourceId === "attention-row-0")).toBe(true);

    const resolved = test.updateSource("attentionItems", "attention-row-0", { status: "resolved", updatedAt: 600 });
    await syncContextActiveRow(test.ctx, "attention", resolved);
    const deleted = test.updateSource("attentionItems", "attention-row-1", { status: "resolved", updatedAt: 601 });
    await syncContextActiveRow(test.ctx, "attention", deleted);
    test.deleteSource("attentionItems", "attention-row-1");
    expect(test.transactionCanCommit(baseRevision)).toBe(false);

    await runActiveMigration(test);
    const ids = [...test.active.values()].map((row) => row.sourceId);
    expect(ids).not.toContain("attention-row-0");
    expect(ids).not.toContain("attention-row-1");
  });

  it("removes stale, inactive, deleted and duplicate active rows during bounded cleanup", async () => {
    const test = activeMigrationHarness();
    await runUntilCleanup(test);
    const jobZero = [...test.active.values()].find((row) => row.sourceId === "job-0");
    expect(jobZero).toBeTruthy();
    test.addActive({ ...jobZero, _id: "duplicate-job-0", version: BRAIN_ACTIVE_INDEX_VERSION - 1, rank: 1 });
    test.addActive({ ...jobZero, _id: "inactive-job-40", sourceId: "job-40", rank: 1000 });
    const attentionOne = [...test.active.values()].find((row) => row.sourceId === "attention-row-1");
    test.deleteSource("attentionItems", "attention-row-1");
    expect(attentionOne).toBeTruthy();
    test.addActive({
      ...jobZero,
      _id: "orphan-job",
      sourceId: "job-missing",
      rank: 1000,
    });

    await runActiveMigration(test);
    const values = [...test.active.values()];
    expect(values.filter((row) => row.source === "job" && row.sourceId === "job-0")).toHaveLength(1);
    expect(values.some((row) => row.sourceId === "job-40")).toBe(false);
    expect(values.some((row) => row.sourceId === "attention-row-1")).toBe(false);
    expect(values.some((row) => row.sourceId === "job-missing")).toBe(false);
    expect(values.every((row) => row.version === BRAIN_ACTIVE_INDEX_VERSION)).toBe(true);
    expect(test.pagination.filter((page) => page.table === "brainContextActive").every((page) =>
      page.numItems <= 32 && page.maximumRowsRead <= 32,
    )).toBe(true);
  });

  it("preserves a dirty writer when the final completion transaction loses its race", async () => {
    const test = activeMigrationHarness();
    await runUntilCleanup(test);
    while (test.pagination.filter((page) => page.table === "brainContextActive").length < 4) {
      await activeHandler(test.ctx, migrationArgs(test));
    }
    expect(test.getState().activeIndexComplete).toBe(false);
    const baseRevision = test.revision();
    const attemptedCompletion = test.fork();
    expect(await activeHandler(attemptedCompletion.ctx, migrationArgs(attemptedCompletion))).toMatchObject({
      complete: true,
    });

    const newest = test.updateSource("jobRuntime", "job-row-0", { priority: 7, updatedAt: 700 });
    await syncContextActiveRow(test.ctx, "job", newest);
    await requestContextRefresh(test.ctx, ["work"]);
    expect(test.transactionCanCommit(baseRevision)).toBe(false);

    const result = await activeHandler(test.ctx, migrationArgs(test));
    expect(result).toMatchObject({ complete: true, phase: "cleanup" });
    expect(test.getState()).toMatchObject({
      activeIndexComplete: true,
      dirtySources: ["work", "projects", "attention"],
    });
    expect([...test.active.values()].find((row) => row.sourceId === "job-0")?.rank).toBe(7);
  });
});
