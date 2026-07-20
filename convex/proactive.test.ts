import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "./proactive";
import { deriveProactiveSignals } from "./proactivePolicy";

const WORKER_TOKEN = "bounded-proactive-test-worker";

function reconcileHarness(input: {
  now: number;
  goals: any[];
  attention: any[];
}) {
  let state: any = null;
  const writes: Array<{ operation: string; table: string; value: any }> = [];
  const schedules: Array<{ delay: number; args: any }> = [];
  const attention = new Map(input.attention.map((row) => [row.fingerprint, row]));

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
          async take(limit: number) {
            if (table === "projectGoals") {
              return input.goals.filter((row) => row.status === filters.status).slice(0, limit);
            }
            if (table === "jobRuntime") return [];
            throw new Error(`Unexpected bounded read from ${table}`);
          },
          async first() {
            if (table === "proactiveReconcileState") return state;
            if (table === "attentionItems") return attention.get(String(filters.fingerprint)) ?? null;
            if (table === "missionRuntime") return null;
            throw new Error(`Unexpected singleton read from ${table}`);
          },
        };
        return builder;
      },
      normalizeId(_table: string, value: string) {
        return value;
      },
      async insert(table: string, value: any) {
        writes.push({ operation: "insert", table, value });
        if (table !== "proactiveReconcileState") {
          throw new Error(`Identical reconcile unexpectedly inserted ${table}`);
        }
        state = { ...value, _id: "proactive-state" };
        return state._id;
      },
      async patch(id: string, value: any) {
        writes.push({ operation: "patch", table: "unknown", value });
        if (id !== state?._id) throw new Error(`Identical reconcile unexpectedly patched ${id}`);
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

  return { ctx, writes, schedules, getState: () => state };
}

describe("bounded proactive reconciliation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not rewrite an identical signal or request a context refresh on either reconcile", async () => {
    vi.stubEnv("JARVIS_WORKER_TOKEN", WORKER_TOKEN);
    const now = 2_000_000_000_000;
    const goal = {
      _id: "goal-1",
      project: "jarvis",
      title: "Complete context rollout",
      status: "blocked",
      priority: 90,
      blockedBy: "Provider review is pending",
      updatedAt: now - 1_000,
    };
    const [signal] = deriveProactiveSignals({ goals: [goal], jobs: [], now });
    const test = reconcileHarness({
      now,
      goals: [goal],
      attention: [{
        _id: "attention-1",
        ...signal,
        status: "open",
        createdAt: now - 5_000,
        updatedAt: now - 5_000,
      }],
    });
    const handler = (reconcile as unknown as {
      _handler: (ctx: unknown, args: unknown) => Promise<any>;
    })._handler;

    await expect(handler(test.ctx, { now, workerToken: WORKER_TOKEN })).resolves.toMatchObject({
      signals: 1,
      materialChanges: 0,
      newInterruptions: [],
    });
    expect(test.writes).toHaveLength(1);
    expect(test.writes[0]).toMatchObject({ operation: "insert", table: "proactiveReconcileState" });
    expect(test.schedules).toHaveLength(1);
    const firstState = { ...test.getState() };

    await expect(handler(test.ctx, { now: now + 1_000, workerToken: WORKER_TOKEN })).resolves.toMatchObject({
      signals: 1,
      materialChanges: 0,
      newInterruptions: [],
    });
    expect(test.writes).toHaveLength(1);
    expect(test.schedules).toHaveLength(1);
    expect(test.getState()).toEqual(firstState);
  });
});
