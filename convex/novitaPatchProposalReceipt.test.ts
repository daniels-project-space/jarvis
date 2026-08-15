import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";
import { testMissionAdmission } from "./testSourceAdmission";
import { triggerClaimAuthority } from "../src/lib/trigger-machine";
import {
  canonicalNovitaPatchProposalOutcome,
  canonicalNovitaPatchProposalReservation,
} from "../src/lib/novita-patch-proposal-receipt";

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>>; }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "novita-receipt-test-worker";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const priorRuntimeConfig = process.env.JARVIS_NOVITA_QWEN_ATTESTATION;
const priorWorkerToken = process.env.JARVIS_WORKER_TOKEN;

const runtimeConfig = {
  endpointUrl: "https://qwen.endpoint.novita.ai/patch-proposer",
  lifecycle: {
    provider: "novita-serverless-v1",
    minWorkers: 0,
    maxWorkers: 1,
    idleTimeoutSeconds: 300,
    port: 8080,
    maxConcurrent: 1,
    gpuNum: 1,
    startupCommand: "python -m adapter.app",
    healthPath: "/health",
  },
  adapterId: "novita-qwen-patch-proposer-v1",
  configDigest: "a".repeat(64),
  endpointId: "endpoint_123456",
  modelId: "Qwen/Qwen2.5-Coder-14B-Instruct-GPTQ-Int4",
  modelRevision: "16e3d0e4df2aa0a4d819c2d6846df4a452e42d83",
  imageDigest: "sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2",
  quantization: "gptq-int4",
  api: "openai-chat-completions",
  endpointAuth: "hmac-sha256-v1",
  requestLimits: { maxInputBytes: 12_000, maxOutputTokens: 800, maxTurns: 1, timeoutMs: 30_000 },
} as const;

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  if (priorRuntimeConfig === undefined) delete process.env.JARVIS_NOVITA_QWEN_ATTESTATION;
  else process.env.JARVIS_NOVITA_QWEN_ATTESTATION = priorRuntimeConfig;
  if (priorWorkerToken === undefined) delete process.env.JARVIS_WORKER_TOKEN;
  else process.env.JARVIS_WORKER_TOKEN = priorWorkerToken;
});

async function claimedNovitaFixture() {
  process.env.JARVIS_NOVITA_QWEN_ATTESTATION = JSON.stringify(runtimeConfig);
  const t = convexTest(schema, modules);
  const admitted = await testMissionAdmission(t, {
    key: "novita-receipt-fixture",
    workerToken: WORKER,
    repository: "daniels-project-space/jarvis",
    sourceHeadSha: "b".repeat(40),
  });
  const jobId = await t.mutation(api.jobs.enqueueV2, {
    task: "Fix the typo in src/lib/example.ts.",
    repo: "daniels-project-space/jarvis",
    readonly: false,
    missionId: String(admitted.missionId),
    workerToken: WORKER,
  });
  const batch = await t.mutation(api.jobs.reserveDispatchBatch, { limit: 1, workerToken: WORKER });
  const reservation = batch.reservations[0];
  if (!reservation) throw new Error("expected a dispatch reservation");
  const claim = await t.mutation(api.jobs.claimDispatched, {
    jobId,
    dispatchId: reservation.dispatchId,
    ...triggerClaimAuthority(reservation),
    workerRunId: "novita-receipt-run",
    workerToken: WORKER,
  });
  if (!claim || claim.backgroundExecutionProfile?.version !== 2) throw new Error("expected a sealed Novita profile");
  return { t, jobId, reservation, claim, attestation: claim.backgroundExecutionProfile.novitaPatchProposer };
}

function reserveInput(fixture: Awaited<ReturnType<typeof claimedNovitaFixture>>) {
  const policyTaskDigest = sha256(fixture.claim.policyTask);
  const requestDigest = sha256("request-digest");
  const sourceFileCount = 1;
  const inputBytes = 120;
  const reservationDigest = sha256(canonicalNovitaPatchProposalReservation({
    workOrderRevisionDigest: fixture.claim.workOrderRevisionDigest,
    attestation: fixture.attestation,
    policyTaskDigest,
    requestDigest,
    sourceFileCount,
    inputBytes,
  }));
  const receiptId = sha256([
    "jarvis-novita-patch-proposal-receipt-v1",
    String(fixture.claim.workOrderRevisionId),
    reservationDigest,
  ].join(":"));
  return {
    jobId: fixture.jobId,
    expectedAttempt: fixture.claim.attempt,
    workerRunId: "novita-receipt-run",
    authorityDigest: fixture.claim.authorityDigest,
    workOrderRevisionDigest: fixture.claim.workOrderRevisionDigest,
    dispatchGeneration: fixture.reservation.dispatchGeneration,
    dispatchPhase: fixture.reservation.dispatchPhase,
    dispatchReceiptDigest: fixture.reservation.dispatchReceiptDigest,
    dispatchPayloadDigest: fixture.reservation.dispatchPayloadDigest,
    receiptId,
    policyTaskDigest,
    requestDigest,
    sourceFileCount,
    inputBytes,
    reservationDigest,
    workerToken: WORKER,
  } as const;
}

describe("Novita patch-proposal receipt authority", () => {
  it("issues exactly one irreversible reservation and permits only its exact settlement", async () => {
    const fixture = await claimedNovitaFixture();
    const input = reserveInput(fixture);
    const [first, second] = await Promise.all([
      fixture.t.mutation(api.jobs.reserveNovitaPatchProposal, input),
      fixture.t.mutation(api.jobs.reserveNovitaPatchProposal, input),
    ]);
    expect([first?.disposition, second?.disposition].sort()).toEqual(["execute", "held"]);
    const receipts = await fixture.t.run(async (ctx) => await ctx.db.query("novitaPatchProposalReceipts").collect());
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "reserved",
      workOrderRevisionDigest: fixture.claim.workOrderRevisionDigest,
      policyTaskDigest: input.policyTaskDigest,
      requestDigest: input.requestDigest,
    });

    const outcome = "proposed" as const;
    const outputBytes = 91;
    const outcomeDigest = sha256(canonicalNovitaPatchProposalOutcome({
      reservationDigest: input.reservationDigest,
      outcome,
      outputBytes,
    }));
    const settle = {
      workOrderRevisionId: fixture.claim.workOrderRevisionId,
      jobId: fixture.jobId,
      ownerAttempt: fixture.claim.attempt,
      ownerWorkerRunId: input.workerRunId,
      authorityDigest: fixture.claim.authorityDigest,
      ownerDispatchReceiptDigest: input.dispatchReceiptDigest,
      ownerDispatchPayloadDigest: input.dispatchPayloadDigest,
      receiptId: input.receiptId,
      reservationDigest: input.reservationDigest,
      outcome,
      outcomeDigest,
      outputBytes,
      workerToken: WORKER,
    } as const;
    expect(await fixture.t.mutation(api.jobs.settleNovitaPatchProposal, settle)).toBe(true);
    expect(await fixture.t.mutation(api.jobs.settleNovitaPatchProposal, settle)).toBe(true);
    expect(await fixture.t.mutation(api.jobs.settleNovitaPatchProposal, {
      ...settle,
      outcome: "rejected",
      outcomeDigest: sha256(canonicalNovitaPatchProposalOutcome({
        reservationDigest: input.reservationDigest,
        outcome: "rejected",
        failureClass: "response",
        outputBytes: 0,
      })),
      outputBytes: 0,
      failureClass: "response",
    })).toBe(false);
  });

  it("refuses an otherwise valid reservation whose policy-task proof is not the sealed work order", async () => {
    const fixture = await claimedNovitaFixture();
    const sourceFileCount = 1;
    const inputBytes = 120;
    const policyTaskDigest = sha256("different bounded task");
    const requestDigest = sha256("request-digest");
    const reservationDigest = sha256(canonicalNovitaPatchProposalReservation({
      workOrderRevisionDigest: fixture.claim.workOrderRevisionDigest,
      attestation: fixture.attestation,
      policyTaskDigest,
      requestDigest,
      sourceFileCount,
      inputBytes,
    }));
    const receiptId = sha256([
      "jarvis-novita-patch-proposal-receipt-v1",
      String(fixture.claim.workOrderRevisionId),
      reservationDigest,
    ].join(":"));

    await expect(fixture.t.mutation(api.jobs.reserveNovitaPatchProposal, {
      ...reserveInput(fixture),
      policyTaskDigest,
      requestDigest,
      sourceFileCount,
      inputBytes,
      reservationDigest,
      receiptId,
    })).resolves.toBeNull();
    const receipts = await fixture.t.run(async (ctx) => await ctx.db.query("novitaPatchProposalReceipts").collect());
    expect(receipts).toHaveLength(0);
  });
});
