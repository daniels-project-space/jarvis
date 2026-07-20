import { describe, expect, it } from "vitest";
import {
  COMPACT_WORK_STATUSES,
  selectCompactConversationWork,
  snapshot,
} from "./commandCenter";

const currentThread = "thread-current";

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-active",
    task: "Repair the current conversation request",
    label: "Paul · current repair",
    status: "running",
    visibility: "conversation",
    originThreadId: currentThread,
    stage: "testing",
    percent: 64,
    priority: 80,
    createdAt: 100,
    ...overrides,
  };
}

describe("commandCenter.snapshot contract", () => {
  it.each(COMPACT_WORK_STATUSES)("accepts current-conversation %s work", (status) => {
    expect(selectCompactConversationWork([runtime({ status })], currentThread)).toEqual({
      id: "job-active",
      label: "Paul · current repair",
      status,
      stage: "testing",
      percent: 64,
    });
  });

  it.each([
    "pending",
    "paused",
    "awaiting_approval",
    "needs_input",
    "done",
    "error",
    "cancelled",
  ])("excludes the %s state", (status) => {
    expect(selectCompactConversationWork([runtime({ status })], currentThread)).toBeNull();
  });

  it.each([
    ["system visibility", { visibility: "system" }],
    ["another conversation", { originThreadId: "thread-other" }],
    ["unowned legacy work", { originThreadId: undefined }],
    ["a health-check label", { label: "Cloud health audit" }],
    ["a health-check task", { task: "Routine provider health check" }],
    ["a health-check stage", { stage: "stack polling sweep" }],
  ])("excludes %s", (_case, overrides) => {
    expect(selectCompactConversationWork([runtime(overrides)], currentThread)).toBeNull();
  });

  it("projects only the five fields rendered by the compact bar", () => {
    const selected = selectCompactConversationWork([
      runtime({
        task: "t".repeat(600),
        result: "private durable result",
        log: "private live transcript",
        checkpoint: "private checkpoint",
        workerRunId: "run-1",
        branch: "branch-1",
      }),
    ], currentThread);

    expect(Object.keys(selected ?? {}).sort()).toEqual(["id", "label", "percent", "stage", "status"]);
    expect(selected).not.toHaveProperty("task");
    expect(selected).not.toHaveProperty("result");
    expect(selected).not.toHaveProperty("log");
    expect(selected).not.toHaveProperty("checkpoint");
    expect(selected).not.toHaveProperty("workerRunId");
    expect(selected).not.toHaveProperty("branch");
  });

  it("scopes reads to the requested or canonical active thread", async () => {
    const reads: Array<{
      table: string;
      index?: string;
      equalities: Record<string, unknown>;
      order?: string;
      limit?: number;
      first?: boolean;
    }> = [];
    const rowsByStatus: Record<string, Array<Record<string, unknown>>> = {
      running: [runtime({ jobId: "job-running", priority: 60 })],
      dispatching: [runtime({ jobId: "job-dispatching", status: "dispatching", priority: 90 })],
    };
    type MockFilter = {
      eq: (field: string, value: unknown) => MockFilter;
      field: (field: string) => string;
    };
    type MockBuilder = {
      withIndex: (index: string, apply: (q: MockFilter) => unknown) => MockBuilder;
      filter: (apply: (q: MockFilter) => unknown) => MockBuilder;
      order: (direction: string) => MockBuilder;
      take: (limit: number) => Promise<Array<Record<string, unknown>>>;
      first: () => Promise<Record<string, unknown> | null>;
    };
    const ctx = {
      auth: {
        getUserIdentity: async () => ({
          issuer: "https://jarvis-orcin-six.vercel.app",
          subject: "daniel-owner",
        }),
      },
      db: {
        query: (table: string) => {
          const read: (typeof reads)[number] = { table, equalities: {} };
          reads.push(read);
          const filter: MockFilter = {
            eq(field: string, value: unknown) {
              read.equalities[field] = value;
              return filter;
            },
            field(field: string) {
              return field;
            },
          };
          const builder: MockBuilder = {
            withIndex(index: string, apply: (q: typeof filter) => unknown) {
              read.index = index;
              apply(filter);
              return builder;
            },
            filter(apply: (q: typeof filter) => unknown) {
              apply(filter);
              return builder;
            },
            order(direction: string) {
              read.order = direction;
              return builder;
            },
            async take(limit: number) {
              read.limit = limit;
              return rowsByStatus[String(read.equalities.status)] ?? [];
            },
            async first() {
              read.first = true;
              return table === "ui" ? { value: currentThread } : null;
            },
          };
          return builder;
        },
      },
    };

    const handler = (snapshot as unknown as {
      _handler: (context: unknown, args: { threadId?: string }) => Promise<unknown>;
    })._handler;
    const result = await handler(ctx, { threadId: currentThread });

    expect(result).toEqual({
      active: {
        id: "job-dispatching",
        label: "Paul · current repair",
        status: "dispatching",
        stage: "testing",
        percent: 64,
      },
    });
    const expectedRuntimeReads = COMPACT_WORK_STATUSES.map((status) => ({
      table: "jobRuntime",
      index: "by_visibility_status_priority",
      equalities: {
        visibility: "conversation",
        status,
        originThreadId: currentThread,
      },
      order: "desc",
      limit: 12,
    }));
    expect(reads).toEqual(expectedRuntimeReads);
    expect(reads.some((read) => read.table === "attentionItems" || read.table === "approvals")).toBe(false);

    reads.length = 0;
    expect(await handler(ctx, {})).toEqual(result);
    expect(reads).toEqual([
      {
        table: "ui",
        index: "by_key",
        equalities: { key: "activeThread" },
        first: true,
      },
      ...expectedRuntimeReads,
    ]);
  });
});
