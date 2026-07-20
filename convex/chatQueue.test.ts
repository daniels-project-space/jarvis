import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimNext, touchRunner } from "./chatQueue";

type Row = Record<string, any> & { _id: string };

function createDb() {
  const tables = new Map<string, Row[]>([
    ["ui", []],
    ["chatMessages", []],
    ["chatSessions", []],
  ]);
  let nextId = 0;
  const rows = (table: string) => tables.get(table) ?? [];
  const db = {
    query(table: string) {
      const equalities: Record<string, unknown> = {};
      let direction = "asc";
      const builder = {
        withIndex(_name: string, apply: (q: { eq: (field: string, value: unknown) => any }) => unknown) {
          const index = {
            eq(field: string, value: unknown) {
              equalities[field] = value;
              return index;
            },
          };
          apply(index);
          return builder;
        },
        order(nextDirection: string) {
          direction = nextDirection;
          return builder;
        },
        async first() {
          return filtered()[0] ?? null;
        },
        async take(limit: number) {
          return filtered().slice(0, limit);
        },
      };
      const filtered = () => rows(table)
        .filter((row) => Object.entries(equalities).every(([field, value]) => row[field] === value))
        .sort((left, right) => direction === "desc"
          ? Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0)
          : Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0));
      return builder;
    },
    async get(id: string) {
      return [...tables.values()].flat().find((row) => row._id === id) ?? null;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      const row = await db.get(id);
      if (row) Object.assign(row, patch);
    },
    async insert(table: string, value: Record<string, unknown>) {
      const row = { _id: `${table}-${++nextId}`, ...value } as Row;
      if (!tables.has(table)) tables.set(table, []);
      tables.get(table)!.push(row);
      return row._id;
    },
  };
  return { db, rows };
}

type MutationHandler<TArgs> = (ctx: { db: ReturnType<typeof createDb>["db"] }, args: TArgs) => Promise<any>;
const touch = (touchRunner as unknown as { _handler: MutationHandler<any> })._handler;
const claim = (claimNext as unknown as { _handler: MutationHandler<any> })._handler;

describe("foreground queue lease handoff", () => {
  const workerToken = "deterministic-worker-token";
  const originalWorkerToken = process.env.JARVIS_WORKER_TOKEN;

  beforeEach(() => {
    process.env.JARVIS_WORKER_TOKEN = workerToken;
    vi.spyOn(Date, "now").mockReturnValue(10_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWorkerToken === undefined) delete process.env.JARVIS_WORKER_TOKEN;
    else process.env.JARVIS_WORKER_TOKEN = originalWorkerToken;
  });

  it("claims messages continuously across one atomic owner change, exactly once", async () => {
    const harness = createDb();
    const ctx = { db: harness.db };
    expect(await touch(ctx, { runnerId: "old", workerToken })).toBe(true);
    expect(harness.rows("ui")[0].value).toBe("old");

    // The successor exists but is still prewarming, so the old owner remains
    // authoritative and a message arriving now is not stranded in a cold gap.
    await harness.db.insert("chatMessages", {
      threadId: "main",
      role: "user",
      text: "during prewarm",
      status: "pending",
      requestId: "request-during",
      delivery: "foreground",
      createdAt: 10_001,
    });
    const during = await claim(ctx, { runnerId: "old", workerToken });
    expect(during?.userText).toBe("during prewarm");

    expect(await touch(ctx, { runnerId: "new", workerToken })).toBe(false);
    expect(await touch(ctx, { runnerId: "new", takeoverFrom: "old", workerToken })).toBe(true);
    expect(harness.rows("ui")[0].value).toBe("new");
    expect(await touch(ctx, { runnerId: "old", workerToken })).toBe(false);

    const boundaryId = await harness.db.insert("chatMessages", {
      threadId: "main",
      role: "user",
      text: "at takeover",
      status: "pending",
      requestId: "request-boundary",
      delivery: "foreground",
      createdAt: 10_003,
    });
    expect(await claim(ctx, { runnerId: "old", workerToken })).toBeNull();
    const boundary = await claim(ctx, { runnerId: "new", workerToken });
    expect(boundary?.userText).toBe("at takeover");
    expect(await claim(ctx, { runnerId: "new", workerToken })).toBeNull();

    const assistants = harness.rows("chatMessages")
      .filter((row) => row.role === "assistant" && row.parentMessageId === boundaryId);
    expect(assistants).toHaveLength(1);
    expect(harness.rows("chatMessages").find((row) => row._id === boundaryId)?.status).toBe("done");
  });

  it("accepts legacy claims without runnerId during a rolling deployment", async () => {
    const harness = createDb();
    const ctx = { db: harness.db };
    await harness.db.insert("chatMessages", {
      threadId: "main",
      role: "user",
      text: "legacy",
      status: "pending",
      createdAt: 1,
    });
    await expect(claim(ctx, { workerToken })).resolves.toMatchObject({ userText: "legacy" });
  });
});
