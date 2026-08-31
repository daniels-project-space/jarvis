import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "incident-lifecycle-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.restoreAllMocks();
});

async function report(t: ReturnType<typeof convexTest>, signature = "client:tts") {
  return await t.mutation(api.incidents.report, {
    source: "client",
    signature,
    message: "Jarvis speech route failed: TypeError: Failed to fetch",
    workerToken: WORKER,
  });
}

describe("incident observation fencing", () => {
  it("records isolated browser fetch failures without spending repair workers or paging Daniel", async () => {
    const t = convexTest(schema, modules);
    const id = await report(t);

    await expect(t.run(async (ctx) => ({
      incident: await ctx.db.get(id),
      attention: await ctx.db.query("attentionItems").collect(),
    }))).resolves.toMatchObject({
      incident: { status: "resolved", count: 1, attempts: 0 },
      attention: [],
    });

    await expect(t.mutation(api.incidents.claimForRepair, {
      workerToken: WORKER,
      limit: 2,
      maxAttempts: 2,
    })).resolves.toEqual({ claims: [], escalations: [] });

    await expect(t.run(async (ctx) => await ctx.db.get(id))).resolves.toMatchObject({
      status: "resolved",
      count: 1,
      attempts: 0,
      lastSeenAt: expect.any(Number),
    });
  });

  it.each(["dispatched", "needs-daniel"] as const)(
    "retires a pre-threshold one-off browser fetch incident left %s",
    async (status) => {
      const t = convexTest(schema, modules);
      const id = await report(t, `client:legacy-${status}`);
      await t.mutation(api.incidents.setStatus, {
        id,
        status,
        workerToken: WORKER,
      });

      await expect(t.mutation(api.incidents.claimForRepair, {
        workerToken: WORKER,
      })).resolves.toEqual({ claims: [], escalations: [] });
      await expect(t.run(async (ctx) => await ctx.db.get(id))).resolves.toMatchObject({
        status: "resolved",
        attempts: 0,
        observedCountAtLastAttempt: 1,
      });
    },
  );

  it("admits a repair only after the transient network failure really recurs", async () => {
    const t = convexTest(schema, modules);
    const id = await report(t);
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER });
    await report(t);
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER });

    await expect(t.run(async (ctx) => ({
      incident: await ctx.db.get(id),
      attention: await ctx.db.query("attentionItems").collect(),
    }))).resolves.toMatchObject({
      incident: { status: "resolved", count: 2 },
      attention: [],
    });

    await report(t);

    await expect(t.run(async (ctx) => await ctx.db
      .query("attentionItems")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", `incident:${String(id)}`))
      .first())).resolves.toMatchObject({
        status: "open",
        title: "Restoring Jarvis's connection",
        detail: expect.not.stringMatching(/failed to fetch/i),
      });

    const result = await t.mutation(api.incidents.claimForRepair, {
      workerToken: WORKER,
      limit: 2,
      maxAttempts: 2,
    });
    expect(result.escalations).toEqual([]);
    expect(result.claims).toEqual([expect.objectContaining({ id, count: 3, attempts: 1 })]);
  });

  it("retires the legacy failed-fetch approval when no live recurrence remains", async () => {
    const t = convexTest(schema, modules);
    const attentionId = await t.run(async (ctx) => await ctx.db.insert("attentionItems", {
      fingerprint: "jarvis:failed-fetch-unhandled-rejection",
      title: "Approve root-cause repair for repeated failed fetch",
      detail: "A stale approval from the old incident policy.",
      severity: "warning",
      impact: 65,
      urgency: 60,
      confidence: 1,
      actionClass: "ask",
      status: "open",
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    }));

    await expect(t.mutation(api.incidents.claimForRepair, {
      workerToken: WORKER,
    })).resolves.toEqual({ claims: [], escalations: [] });
    await expect(t.run(async (ctx) => await ctx.db.get(attentionId))).resolves.toMatchObject({
      status: "resolved",
      updatedAt: expect.any(Number),
    });
  });

  it("silently monitors an exhausted repair unless the product reports the failure again", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.incidents.report, {
      source: "api/chat",
      signature: "route:one-failure",
      message: "One route failure",
      workerToken: WORKER,
    });
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER, maxAttempts: 2 });
    await t.mutation(api.incidents.setStatus, { id, status: "open", workerToken: WORKER });
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER, maxAttempts: 2 });
    await t.mutation(api.incidents.setStatus, { id, status: "open", workerToken: WORKER });

    await expect(t.mutation(api.incidents.claimForRepair, {
      workerToken: WORKER,
      maxAttempts: 2,
    })).resolves.toEqual({ claims: [], escalations: [] });
    await expect(t.run(async (ctx) => await ctx.db.get(id))).resolves.toMatchObject({
      status: "resolved",
      count: 1,
      attempts: 2,
      observedCountAtLastAttempt: 1,
    });
  });

  it("escalates only a recurrence observed after the final repair attempt", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.incidents.report, {
      source: "api/chat",
      signature: "route:recurring-failure",
      message: "A recurring route failure",
      workerToken: WORKER,
    });
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER, maxAttempts: 2 });
    await t.mutation(api.incidents.setStatus, { id, status: "open", workerToken: WORKER });
    await t.mutation(api.incidents.claimForRepair, { workerToken: WORKER, maxAttempts: 2 });
    await t.mutation(api.incidents.setStatus, { id, status: "open", workerToken: WORKER });
    await t.mutation(api.incidents.report, {
      source: "api/chat",
      signature: "route:recurring-failure",
      message: "A recurring route failure",
      workerToken: WORKER,
    });

    const result = await t.mutation(api.incidents.claimForRepair, {
      workerToken: WORKER,
      maxAttempts: 2,
    });
    expect(result.claims).toEqual([]);
    expect(result.escalations).toEqual([
      expect.objectContaining({ id, attempts: 2 }),
    ]);
  });

  it("retires a proven-healthy incident only if no newer report raced the check", async () => {
    const t = convexTest(schema, modules);
    const id = await report(t, "client:health-fenced");
    await report(t, "client:health-fenced");

    await expect(t.mutation(api.incidents.resolveIfUnchanged, {
      id,
      expectedCount: 1,
      workerToken: WORKER,
    })).resolves.toBe(false);
    await expect(t.mutation(api.incidents.resolveIfUnchanged, {
      id,
      expectedCount: 2,
      workerToken: WORKER,
    })).resolves.toBe(true);
    await expect(t.run(async (ctx) => await ctx.db.get(id))).resolves.toMatchObject({
      status: "resolved",
      attempts: 0,
      observedCountAtLastAttempt: 2,
    });
  });
});
