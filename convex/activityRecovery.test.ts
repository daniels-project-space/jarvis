import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { insertMissionWithRuntime, upsertJobRuntime } from "./controlPlane";

const modules = import.meta.glob("./**/*.ts");
const WORKER = "activity-recovery-test-worker";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete process.env.JARVIS_WORKER_TOKEN; });

async function advance(t: ReturnType<typeof convexTest>, ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
  vi.advanceTimersByTime(0);
  await t.finishInProgressScheduledFunctions();
}

describe("activity-conditional durable recovery", () => {
  it("keeps missions with paused children idle while preserving terminal-child review", async () => {
    const t = convexTest(schema, modules);
    const jobId = await t.run(async ctx => {
      const now = Date.now();
      const missionId = await insertMissionWithRuntime(ctx, { goal: "a real paused mission", status: "running", mode: "single", agentCount: 1, createdAt: now, updatedAt: now });
      const job = { task: "waiting for owner", status: "paused", missionId: String(missionId), createdAt: now };
      const jobId = await ctx.db.insert("jobs", job);
      await upsertJobRuntime(ctx, { ...job, _id: jobId });
      return jobId;
    });
    expect((await t.query(api.activityRecovery.fleetDemand, { workerToken: WORKER })).fleet).toBe(false);
    await advance(t, 60_000);
    expect(fetch).not.toHaveBeenCalled();
    await t.run(async ctx => {
      await ctx.db.patch(jobId, { status: "done" });
      await upsertJobRuntime(ctx, (await ctx.db.get(jobId))!);
    });
    expect((await t.query(api.activityRecovery.fleetDemand, { workerToken: WORKER })).fleet).toBe(true);
  });
  it("does no Trigger work and arms no minute timer when idle", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.activityRecovery.tick, {})).toEqual({ chat: false, fleet: false, nextAt: null });
    expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(t.query(api.activityRecovery.demand, {})).rejects.toThrow();
  });

  it("coalesces admissions and retries a lost wake while the turn remains pending", async () => {
    const t = convexTest(schema, modules);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
    for (const requestId of ["first", "second"]) await t.mutation(api.chatQueue.sendMessage, {
      threadId: "main", text: "hello", requestId, workerToken: WORKER,
    });
    const timers = await t.run(ctx => ctx.db.query("activityRecoveryTimers").collect());
    expect(timers).toHaveLength(1);
    const waiting = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(waiting).toHaveLength(1);
    await advance(t, 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(t, 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toMatchObject({ chat: true, fleet: false });
    await t.run(async ctx => {
      for (const message of await ctx.db.query("chatMessages").collect()) await ctx.db.patch(message._id, { status: "done" });
    });
    await advance(t, 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await t.run(ctx => ctx.db.query("activityRecoveryTimers").unique()))?.scheduledId).toBeUndefined();
  });

  it("sleeps to the reminder deadline and lets earlier new work pull the timer forward", async () => {
    const t = convexTest(schema, modules);
    const at = Date.now() + 3 * 3600_000;
    const id = await t.mutation(api.reminders.add, { text: "call mum", at, workerToken: WORKER });
    await advance(t, 60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(await t.run(ctx => ctx.db.query("activityRecoveryTimers").unique())).toMatchObject({ at });
    await t.mutation(api.chatQueue.sendMessage, { threadId: "main", text: "hello", requestId: "new-work", workerToken: WORKER });
    expect(await t.run(ctx => ctx.db.query("activityRecoveryTimers").unique())).toMatchObject({ at: Date.now() + 60_000 });
    await t.run(async ctx => {
      for (const message of await ctx.db.query("chatMessages").collect()) await ctx.db.patch(message._id, { status: "done" });
    });
    await advance(t, 60_000);
    await advance(t, at - Date.now());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ chat: false, fleet: true });
    const claimed = await t.mutation(api.reminders.due, { workerToken: WORKER });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]._id).toBe(id);
    expect((await t.query(api.activityRecovery.demand, { workerToken: WORKER })).fleet).toBe(false);
    await advance(t, 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(t, 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not revive a cancelled reminder or an obsolete timer", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.reminders.add, { text: "cancel me", at: Date.now() + 3600_000, workerToken: WORKER });
    await t.mutation(api.reminders.cancel, { match: "cancel me", workerToken: WORKER });
    expect(await t.mutation(internal.activityRecovery.tick, { at: Date.now() - 1 })).toBeNull();
    await advance(t, 60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(await t.query(api.activityRecovery.demand, { workerToken: WORKER })).toEqual({ chat: false, fleet: false, nextAt: null });
  });
});
