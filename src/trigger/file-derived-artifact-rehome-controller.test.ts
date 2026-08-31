import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.CONVEX_URL = "https://convex.test";
  process.env.JARVIS_FILE_REHOME_TOKEN = "file-derived-artifact-rehome-test-token";
  return { triggerTask: vi.fn() };
});

vi.mock("@trigger.dev/sdk/v3", () => ({
  task: (definition: unknown) => definition,
  tasks: { trigger: mocks.triggerTask },
}));

import { runFileDerivedArtifactRehomeController } from "./file-derived-artifact-rehome-controller";

const REHOME_ID = "rehome-controller-123e4567-e89b-12d3-a456-426614174000";

function configure(options: {
  phase: string;
  pending?: Array<{ rehomeId: string; targetGeneration?: number; claimToken?: string }>;
  preflightDone?: boolean;
  preflightStatus?: string;
  auditDone?: boolean;
  auditStatus?: string;
  ready?: boolean;
}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string };
    calls.push(body.path);
    const value = body.path === "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight"
      ? { isDone: options.preflightDone ?? true, phase: options.phase, status: options.preflightStatus ?? ((options.preflightDone ?? true) ? "complete" : "scanning") }
      : body.path === "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory"
      ? { phase: options.phase }
      : body.path === "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes"
        ? options.pending ?? []
        : body.path === "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeAudit"
          ? { isDone: Boolean(options.auditDone), status: options.auditStatus ?? (options.auditDone ? "complete" : "scanning") }
        : body.path === "fileDerivedArtifactRehomes:finalizeFileDerivedArtifactRehome"
          ? { ready: Boolean(options.ready) }
          : null;
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

describe("file-derived-artifact rehome controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.triggerTask.mockResolvedValue({ id: "scheduled" });
  });

  it("advances one bounded inventory page and schedules the discovered migration plus its next page", async () => {
    const claimToken = "rehome-claim-controller-123e4567-e89b-12d3-a456-426614174000-g1";
    const calls = configure({ phase: "inventorying", pending: [{ rehomeId: REHOME_ID, targetGeneration: 0, claimToken }] });
    await expect(runFileDerivedArtifactRehomeController({ limit: 4 }))
      .resolves.toEqual({ phase: "inventorying", scheduled: 1, cleanupPreflightStatus: "complete", ready: false });
    expect(calls).toEqual([
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory",
      "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes",
    ]);
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome",
      expect.objectContaining({ rehomeId: REHOME_ID, claimToken }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("jarvis-file-derived-artifact-rehome-"),
        idempotencyKeyTTL: "3m",
      }),
    );
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit: 4 },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("inventory-") }),
    );
  });

  it("asks Convex to finalize only after its durable pending list is empty", async () => {
    const calls = configure({ phase: "rehoming", pending: [], auditDone: true, ready: true });
    await expect(runFileDerivedArtifactRehomeController())
      .resolves.toEqual({ phase: "rehoming", scheduled: 0, cleanupPreflightStatus: "complete", auditStatus: "complete", ready: true });
    expect(calls).toEqual([
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory",
      "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeAudit",
      "fileDerivedArtifactRehomes:finalizeFileDerivedArtifactRehome",
    ]);
    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });

  it("keeps a delayed reconciliation alive when a worker was claimed but dies before its wake", async () => {
    const calls = configure({ phase: "rehoming", pending: [], auditDone: true, ready: false });
    await expect(runFileDerivedArtifactRehomeController({ limit: 3 }))
      .resolves.toEqual({ phase: "rehoming", scheduled: 0, cleanupPreflightStatus: "complete", auditStatus: "complete", ready: false });
    expect(calls).toEqual([
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory",
      "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeAudit",
      "fileDerivedArtifactRehomes:finalizeFileDerivedArtifactRehome",
    ]);
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit: 3 },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("jarvis-file-derived-artifact-rehome-reconcile-"),
        delay: "1m",
      }),
    );
  });

  it("uses one deterministic provider admission when two controllers see the same unclaimed row", async () => {
    configure({
      phase: "rehoming",
      pending: [{
        rehomeId: REHOME_ID,
        targetGeneration: 0,
        claimToken: "rehome-claim-controller-123e4567-e89b-12d3-a456-426614174000-g1",
      }],
    });
    await runFileDerivedArtifactRehomeController();
    await runFileDerivedArtifactRehomeController();
    const workerAdmissions = mocks.triggerTask.mock.calls.filter(([taskId]) => taskId === "jarvis-file-derived-artifact-rehome");
    expect(workerAdmissions).toHaveLength(2);
    expect(workerAdmissions[0][1]).toEqual(workerAdmissions[1][1]);
    expect(workerAdmissions[0][2]).toEqual(workerAdmissions[1][2]);
    expect(workerAdmissions[0][2]).toMatchObject({ idempotencyKeyTTL: "3m" });
  });

  it("pages the durable audit before finalization and keeps reconciliation alive", async () => {
    const calls = configure({ phase: "rehoming", pending: [], auditDone: false, auditStatus: "scanning" });
    await expect(runFileDerivedArtifactRehomeController({ limit: 2 }))
      .resolves.toEqual({ phase: "rehoming", scheduled: 0, cleanupPreflightStatus: "complete", auditStatus: "scanning", ready: false });
    expect(calls).toEqual([
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory",
      "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeAudit",
    ]);
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit: 2 },
      expect.objectContaining({ delay: "1m" }),
    );
  });

  it("finishes paginated cleanup-history preflight before inventory begins", async () => {
    const calls = configure({ phase: "frozen", preflightDone: false, preflightStatus: "scanning" });
    await expect(runFileDerivedArtifactRehomeController({ limit: 2 }))
      .resolves.toEqual({ phase: "frozen", scheduled: 0, cleanupPreflightStatus: "scanning", ready: false });
    expect(calls).toEqual([
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeCleanupPreflight",
      "fileDerivedArtifactRehomes:advanceFileDerivedArtifactRehomeInventory",
      "fileDerivedArtifactRehomes:pendingFileDerivedArtifactRehomes",
    ]);
    expect(mocks.triggerTask).toHaveBeenCalledWith(
      "jarvis-file-derived-artifact-rehome-controller",
      { limit: 2 },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("inventory-") }),
    );
  });
});
