import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { controllerSessionStatusFromRows } from "./controllerSession";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "controller-session-repair-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

describe("controller session control-plane status", () => {
  it("surfaces only a real needs-input controller hold", () => {
    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
    ])).toEqual({ state: "repair_required", code: "rotation_uncertain" });

    expect(controllerSessionStatusFromRows([
      {
        status: "running",
        active: true,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
      {
        status: "needs_input",
        active: false,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
    ])).toEqual({ state: "clear" });
  });

  it("recognizes a legacy held job's bounded operator signal without treating task text as status", () => {
    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        task: "Explain JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: in plain English",
      },
    ])).toEqual({ state: "clear" });

    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        progress: "Jarvis needs repair. JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: re-enrol the managed session",
      },
    ])).toEqual({ state: "repair_required", code: "rotation_uncertain" });
  });

  it("supersedes only older repair generations and preserves a new failure", () => {
    const oldHold = {
      status: "needs_input",
      active: true,
      controllerSessionRepairRequired: true,
      controllerSessionHoldCode: "rotation_uncertain",
    };
    expect(controllerSessionStatusFromRows([oldHold], 1)).toEqual({ state: "clear" });
    expect(controllerSessionStatusFromRows([{
      ...oldHold,
      controllerSessionRepairGeneration: 1,
    }], 1)).toEqual({ state: "repair_required", code: "rotation_uncertain" });
  });

  it("clears only a hold older than a trusted operational success", () => {
    const hold = {
      status: "needs_input",
      active: true,
      updatedAt: 200,
      controllerSessionHoldAt: 200,
      controllerSessionRepairRequired: true,
      controllerSessionRepairGeneration: 1,
      controllerSessionHoldCode: "credential_broker_unavailable",
    };
    expect(controllerSessionStatusFromRows([hold], 1, 199)).toEqual({
      state: "repair_required",
      code: "credential_broker_unavailable",
    });
    expect(controllerSessionStatusFromRows([hold], 1, 201)).toEqual({ state: "clear" });
  });

  it("records only monotonic, credential-free repair receipts", async () => {
    const t = convexTest(schema, modules);
    const tokenExpiresAt = Date.now() + 4 * 60 * 60_000;
    const first = await t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 7,
      tokenExpiresAt,
    });
    expect(first).toMatchObject({ generation: 1, sessionVersion: 7, tokenExpiresAt });
    await expect(t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 7,
      tokenExpiresAt,
    })).resolves.toEqual(first);
    await expect(t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 6,
      tokenExpiresAt,
    })).resolves.toBe(false);
    const second = await t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 8,
      tokenExpiresAt: tokenExpiresAt + 60_000,
    });
    expect(second).toMatchObject({ generation: 2, sessionVersion: 8 });
    const rows = await t.run((ctx) => ctx.db.query("controllerSessionRepairs").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      key: "managed-codex-session",
      generation: 2,
      sessionVersion: 8,
      tokenExpiresAt: tokenExpiresAt + 60_000,
    }));
    expect(Object.keys(rows[0]).sort()).toEqual([
      "_creationTime",
      "_id",
      "generation",
      "key",
      "repairedAt",
      "sessionVersion",
      "tokenExpiresAt",
    ]);
  });

  it("records a bounded operational success only after trusted enrollment", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.controllerSession.confirmOperationalSuccess, {
      workerToken: WORKER,
      source: "foreground",
    })).resolves.toBe(false);
    await t.mutation(api.controllerSession.confirmRepair, {
      workerToken: WORKER,
      sessionVersion: 1,
      tokenExpiresAt: Date.now() + 4 * 60 * 60_000,
    });
    await expect(t.mutation(api.controllerSession.confirmOperationalSuccess, {
      workerToken: WORKER,
      source: "background",
    })).resolves.toBe(true);
    const row = await t.run((ctx) => ctx.db.query("controllerSessionRepairs").first());
    expect(row).toMatchObject({
      operationalSuccessSource: "background",
      operationalSuccessAt: expect.any(Number),
    });
    expect(row).not.toHaveProperty("transcript");
    expect(row).not.toHaveProperty("credential");
  });
});
