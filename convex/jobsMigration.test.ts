import { describe, expect, it } from "vitest";
import { migrateControlPlaneStep, reconciledLegacyDeliveryMode } from "./jobs";

type MigrationState = {
  _id: string;
  key: string;
  jobsCursor?: string;
  jobsComplete: boolean;
  jobsScanned: number;
  jobsRepaired: number;
  missionsCursor?: string;
  missionsComplete: boolean;
  missionsScanned: number;
  missionsRepaired: number;
  completedAt?: number;
  updatedAt: number;
};

type FakePage = {
  page: any[];
  isDone: boolean;
  continueCursor: string;
};

function migrationHarness(input?: {
  state?: Partial<MigrationState>;
  jobs?: FakePage[];
  missions?: FakePage[];
}) {
  const state: MigrationState = {
    _id: "migration-1",
    key: "compact-runtime-v1",
    jobsComplete: false,
    jobsScanned: 0,
    jobsRepaired: 0,
    missionsComplete: false,
    missionsScanned: 0,
    missionsRepaired: 0,
    updatedAt: 1,
    ...input?.state,
  };
  const pages = {
    jobs: [...(input?.jobs ?? [])],
    missions: [...(input?.missions ?? [])],
  };
  let invocationPaginations = 0;
  const paginationHistory: Array<{ table: "jobs" | "missions"; options: any }> = [];

  const ctx = {
    db: {
      query(table: string) {
        if (table === "controlPlaneMigrations") {
          return {
            withIndex: () => ({ first: async () => state }),
          };
        }
        if (table !== "jobs" && table !== "missions") throw new Error(`unexpected table ${table}`);
        return {
          withIndex: () => ({
            order: () => ({
              paginate: async (options: any) => {
                invocationPaginations += 1;
                if (invocationPaginations > 1) {
                  throw new Error("regression: a migration invocation attempted a second paginated query");
                }
                paginationHistory.push({ table, options });
                const next = pages[table].shift();
                if (!next) throw new Error(`missing fake ${table} page`);
                return next;
              },
            }),
          }),
        };
      },
      async patch(id: string, patch: Record<string, unknown>) {
        expect(id).toBe(state._id);
        Object.assign(state, patch);
      },
    },
  };

  return {
    state,
    paginationHistory,
    async step() {
      invocationPaginations = 0;
      const result = await migrateControlPlaneStep(ctx);
      return { result, paginations: invocationPaginations };
    },
  };
}

describe("control-plane projection migration", () => {
  it("mints branch-only policy while preserving persisted automatic reconciliation", () => {
    expect(reconciledLegacyDeliveryMode(false)).toBe("branch_only");
    expect(reconciledLegacyDeliveryMode(false, "manual")).toBe("branch_only");
    expect(reconciledLegacyDeliveryMode(false, "branch_only")).toBe("branch_only");
    expect(reconciledLegacyDeliveryMode(false, "auto_merge")).toBe("auto_merge");
    expect(reconciledLegacyDeliveryMode(true, "auto_merge")).toBe("read_only");
  });

  it("performs at most one real pagination call in each mutation invocation", async () => {
    const harness = migrationHarness({
      jobs: [{ page: [], isDone: true, continueCursor: "jobs-done" }],
      missions: [{ page: [], isDone: true, continueCursor: "missions-done" }],
    });

    const jobs = await harness.step();
    expect(jobs.paginations).toBe(1);
    expect(jobs.result).toMatchObject({ phase: "jobs", complete: false });

    const missions = await harness.step();
    expect(missions.paginations).toBe(1);
    expect(missions.result).toMatchObject({ phase: "missions", complete: true });

    expect(harness.paginationHistory.map(({ table }) => table)).toEqual(["jobs", "missions"]);
  });

  it("persists bounded cursors and continues one page at a time", async () => {
    const harness = migrationHarness({
      jobs: [
        { page: [], isDone: false, continueCursor: "jobs-page-2" },
        { page: [], isDone: true, continueCursor: "jobs-done" },
      ],
      missions: [{ page: [], isDone: true, continueCursor: "missions-done" }],
    });

    const first = await harness.step();
    expect(first.result).toMatchObject({ phase: "jobs", complete: false });
    expect(harness.state).toMatchObject({ jobsCursor: "jobs-page-2", jobsComplete: false });
    expect(harness.paginationHistory[0]).toEqual({
      table: "jobs",
      options: { cursor: null, numItems: 12, maximumRowsRead: 12 },
    });

    const second = await harness.step();
    expect(second.result).toMatchObject({ phase: "jobs", complete: false });
    expect(harness.state.jobsComplete).toBe(true);
    expect(harness.paginationHistory[1]).toEqual({
      table: "jobs",
      options: { cursor: "jobs-page-2", numItems: 12, maximumRowsRead: 12 },
    });

    const third = await harness.step();
    expect(third.result).toMatchObject({ phase: "missions", complete: true });
    expect(harness.paginationHistory[2]).toEqual({
      table: "missions",
      options: { cursor: null, numItems: 1, maximumRowsRead: 1 },
    });
  });

  it("is an idempotent constant-time no-op after both projections complete", async () => {
    const harness = migrationHarness({
      state: {
        jobsComplete: true,
        jobsScanned: 42,
        jobsRepaired: 3,
        missionsComplete: true,
        missionsScanned: 9,
        missionsRepaired: 2,
        completedAt: 500,
      },
    });

    const before = { ...harness.state };
    await expect(harness.step()).resolves.toMatchObject({
      result: { phase: "complete", complete: true },
      paginations: 0,
    });
    await expect(harness.step()).resolves.toMatchObject({
      result: { phase: "complete", complete: true },
      paginations: 0,
    });
    expect(harness.state).toEqual(before);
    expect(harness.paginationHistory).toEqual([]);
  });
});
