import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { projectJobRuntime, projectMissionRuntime } from "./controlPlane";
import { isLegacySynthesisMode } from "./missions";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "mission-synthesis-authority-worker";
const SYNTHESIS_LEASE_MS = 20 * 60 * 1000;

type MissionMode = undefined | "fleet" | "single" | "goal" | "supervised";
type MissionStatus = "running" | "synthesizing";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

async function seedMission(
  t: ReturnType<typeof convexTest>,
  args: {
    mode: MissionMode;
    status?: MissionStatus;
    jobStatus?: string;
    createdAt?: number;
    updatedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const createdAt = args.createdAt ?? Date.now();
    const updatedAt = args.updatedAt ?? createdAt;
    const status = args.status ?? "running";
    const mission = {
      goal: `${args.mode ?? "undefined"} synthesis authority fixture`,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      status,
      agentCount: 1,
      managerAgentId: "jarvis",
      priority: 50,
      risk: "low",
      phase: status === "synthesizing" ? "reviewing" : "executing",
      percent: status === "synthesizing" ? 90 : 88,
      ...(status === "synthesizing"
        ? {
            synthesisAttempt: 1,
            synthesisLeaseUntil: updatedAt + SYNTHESIS_LEASE_MS,
          }
        : {}),
      createdAt,
      updatedAt,
    };
    const missionId = await ctx.db.insert("missions", mission);
    await ctx.db.insert(
      "missionRuntime",
      projectMissionRuntime({ ...mission, _id: missionId }),
    );

    const job = {
      task: `${args.mode ?? "undefined"} completed specialist`,
      missionId: String(missionId),
      label: `${args.mode ?? "undefined"} specialist`,
      status: args.jobStatus ?? "done",
      priority: 50,
      stage: "complete",
      percent: 100,
      attempt: 1,
      maxAttempts: 1,
      heartbeatAt: updatedAt,
      progressAt: updatedAt,
      createdAt,
      completedAt: updatedAt,
    };
    const jobId = await ctx.db.insert("jobs", job);
    await ctx.db.insert("jobRuntime", projectJobRuntime({ ...job, _id: jobId }));
    return { missionId, jobId };
  });
}

async function missionStatus(
  t: ReturnType<typeof convexTest>,
  missionId: Id<"missions">,
) {
  return await t.run(async (ctx) => (await ctx.db.get(missionId))?.status);
}

describe("legacy mission synthesis authority", () => {
  it("uses a positive allowlist for historical fleet modes only", () => {
    expect(isLegacySynthesisMode(undefined)).toBe(true);
    expect(isLegacySynthesisMode("fleet")).toBe(true);
    expect(isLegacySynthesisMode("single")).toBe(true);
    expect(isLegacySynthesisMode("goal")).toBe(false);
    expect(isLegacySynthesisMode("supervised")).toBe(false);
    expect(isLegacySynthesisMode(null)).toBe(false);
    expect(isLegacySynthesisMode("future-protocol")).toBe(false);
  });

  it.each([
    { label: "undefined historical mode", mode: undefined },
    { label: "fleet", mode: "fleet" as const },
    { label: "single", mode: "single" as const },
  ])("lets checkComplete claim $label", async ({ mode }) => {
    const t = convexTest(schema, modules);
    const seeded = await seedMission(t, { mode });

    const claim = await t.mutation(api.missions.checkComplete, {
      id: seeded.missionId,
      workerToken: WORKER,
    });

    expect(claim).toMatchObject({
      id: seeded.missionId,
      synthesisAttempt: 1,
    });
    expect(await missionStatus(t, seeded.missionId)).toBe("synthesizing");
  });

  it.each(["goal", "supervised"] as const)(
    "keeps %s missions out of checkComplete",
    async (mode) => {
      const t = convexTest(schema, modules);
      const seeded = await seedMission(t, { mode });

      expect(await t.mutation(api.missions.checkComplete, {
        id: seeded.missionId,
        workerToken: WORKER,
      })).toBeNull();
      expect(await missionStatus(t, seeded.missionId)).toBe("running");
    },
  );

  it("skips supervised and Goal rows before claiming a ready legacy fleet", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const supervised = await seedMission(t, {
      mode: "supervised",
      createdAt: now - 3_000,
      updatedAt: now - 3_000,
    });
    const goal = await seedMission(t, {
      mode: "goal",
      createdAt: now - 2_000,
      updatedAt: now - 2_000,
    });
    const fleet = await seedMission(t, {
      mode: "fleet",
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });

    const claim = await t.mutation(api.missions.claimReady, {
      workerToken: WORKER,
    });

    expect(claim).toMatchObject({ id: fleet.missionId, synthesisAttempt: 1 });
    expect(await missionStatus(t, supervised.missionId)).toBe("running");
    expect(await missionStatus(t, goal.missionId)).toBe("running");
    expect(await missionStatus(t, fleet.missionId)).toBe("synthesizing");
  });

  it("skips expired supervised and Goal synthesis leases before reclaiming legacy single", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const supervised = await seedMission(t, {
      mode: "supervised",
      status: "synthesizing",
      createdAt: now - 40 * 60_000,
      updatedAt: now - 40 * 60_000,
    });
    const goal = await seedMission(t, {
      mode: "goal",
      status: "synthesizing",
      createdAt: now - 39 * 60_000,
      updatedAt: now - 39 * 60_000,
    });
    const single = await seedMission(t, {
      mode: "single",
      status: "synthesizing",
      createdAt: now - 38 * 60_000,
      updatedAt: now - 38 * 60_000,
    });

    const claim = await t.mutation(api.missions.claimReady, {
      workerToken: WORKER,
    });

    expect(claim).toMatchObject({ id: single.missionId, synthesisAttempt: 2 });
    const attempts = await t.run(async (ctx) => ({
      supervised: (await ctx.db.get(supervised.missionId))?.synthesisAttempt,
      goal: (await ctx.db.get(goal.missionId))?.synthesisAttempt,
      single: (await ctx.db.get(single.missionId))?.synthesisAttempt,
    }));
    expect(attempts).toEqual({ supervised: 1, goal: 1, single: 2 });
  });

  it("rejects legacy finish for supervised and Goal missions while preserving fleet finish", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now() - 40 * 60_000;
    const supervised = await seedMission(t, {
      mode: "supervised",
      status: "synthesizing",
      createdAt: now,
      updatedAt: now,
    });
    const goal = await seedMission(t, {
      mode: "goal",
      status: "synthesizing",
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    const fleet = await seedMission(t, {
      mode: "fleet",
      status: "synthesizing",
      createdAt: now + 2,
      updatedAt: now + 2,
    });
    const finish = (id: Id<"missions">) => t.mutation(api.missions.finish, {
      id,
      summary: "bounded synthesis",
      expectedSynthesisAttempt: 1,
      workerToken: WORKER,
    });

    expect(await finish(supervised.missionId)).toBe(false);
    expect(await finish(goal.missionId)).toBe(false);
    expect(await finish(fleet.missionId)).toBe(true);
    expect(await missionStatus(t, supervised.missionId)).toBe("synthesizing");
    expect(await missionStatus(t, goal.missionId)).toBe("synthesizing");
    expect(await missionStatus(t, fleet.missionId)).toBe("done");
  });
});

describe("mission supervisor schema authority", () => {
  it("accepts only the bounded state, decision-kind, provider, and model unions", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedMission(t, { mode: "supervised" });
    const now = Date.now();
    const stateBase = {
      protocolVersion: 1 as const,
      missionId: seeded.missionId,
      requestDigest: "a".repeat(64),
      requestPayloadJson: "{}",
      epoch: 1,
      nextDecisionSequence: 1,
      inputRevision: 1,
      handledInputRevision: 0,
      dirtyJobIds: [],
      leaseVersion: 0,
      totalJobs: 0,
      maxJobs: 24,
      decisionCount: 0,
      maxDecisions: 64,
      deadlineAt: now + 86_400_000,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    const states = [
      "ready",
      "leased",
      "waiting",
      "paused",
      "needs_input",
      "terminal",
    ] as const;
    await t.run(async (ctx) => {
      for (const state of states) {
        await ctx.db.insert("missionSupervisorState", {
          ...stateBase,
          requestKey: `request:${state}`,
          state,
        });
      }
    });
    await expect(t.run(async (ctx) => await ctx.db.insert(
      "missionSupervisorState",
      {
        ...stateBase,
        requestKey: "request:invalid",
        state: "running",
      } as never,
    ))).rejects.toThrow();

    const decisionBase = {
      protocolVersion: 1 as const,
      missionId: seeded.missionId,
      epoch: 1,
      observedInputRevision: 1,
      snapshotDigest: "b".repeat(64),
      payloadJson: "{}",
      payloadDigest: "c".repeat(64),
      rationale: "bounded authority test",
      decisionOrigin: "model" as const,
      modelProvider: "codex-subscription" as const,
      modelTier: "luna" as const,
      modelId: "gpt-5.6-luna",
      reasoningEffort: "low",
      tierReason: "routine observation",
      supervisorPromptVersion: "v1",
      leaseVersion: 1,
      triggerRunId: "trigger-run",
      createdJobIds: [],
      chatMessageIds: [],
      resultState: "waiting",
      createdAt: now,
    };
    const kinds = [
      "delegate",
      "wait",
      "request_input",
      "replan",
      "synthesize",
      "fail",
    ] as const;
    await t.run(async (ctx) => {
      for (const [index, kind] of kinds.entries()) {
        await ctx.db.insert("missionSupervisorDecisions", {
          ...decisionBase,
          sequence: index + 1,
          decisionKey: `decision:${kind}`,
          kind,
        });
      }
      await ctx.db.insert("missionSupervisorDecisions", {
        ...decisionBase,
        sequence: 50,
        decisionKey: "decision:deterministic-policy",
        kind: "wait",
        decisionOrigin: "policy",
        modelProvider: "deterministic-policy",
        modelId: "jarvis-supervisor-policy-v1",
        reasoningEffort: "none",
      });
    });
    await expect(t.run(async (ctx) => await ctx.db.insert(
      "missionSupervisorDecisions",
      {
        ...decisionBase,
        sequence: 99,
        decisionKey: "decision:invalid-kind",
        kind: "approve",
      } as never,
    ))).rejects.toThrow();
    await expect(t.run(async (ctx) => await ctx.db.insert(
      "missionSupervisorDecisions",
      {
        ...decisionBase,
        sequence: 100,
        decisionKey: "decision:invalid-model",
        kind: "wait",
        modelTier: "cheap",
      } as never,
    ))).rejects.toThrow();
    await expect(t.run(async (ctx) => await ctx.db.insert(
      "missionSupervisorDecisions",
      {
        ...decisionBase,
        sequence: 101,
        decisionKey: "decision:invalid-origin",
        kind: "wait",
        decisionOrigin: "controller",
      } as never,
    ))).rejects.toThrow();
    await expect(t.run(async (ctx) => await ctx.db.insert(
      "missionSupervisorDecisions",
      {
        ...decisionBase,
        sequence: 102,
        decisionKey: "decision:invalid-provider",
        kind: "wait",
        modelProvider: "openai-api",
      } as never,
    ))).rejects.toThrow();
  });
});
