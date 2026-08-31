import { idempotencyKeys, tasks } from "@trigger.dev/sdk/v3";
import type { agentWorker } from "../trigger/agent-runner";
import { resolveConvexUrl } from "./convex-url";
import {
  TRIGGER_AGENT_IDEMPOTENCY_TTL,
  triggerAgentIdempotencyMaterial,
  type TriggerAgentDispatchPhase,
  type TriggerAgentMachinePreset,
  type TriggerAgentMachineReason,
} from "./trigger-machine";
import { BACKGROUND_CONCURRENCY_LIMIT } from "./work-scheduler";

const CONVEX_URL = resolveConvexUrl(process.env.CONVEX_URL, process.env.NEXT_PUBLIC_CONVEX_URL);
const DEFAULT_FAN_OUT = BACKGROUND_CONCURRENCY_LIMIT;

export type AgentFleetReservation = {
  jobId: string;
  dispatchId: string;
  attempt: number;
  expectedAttempt: number;
  dispatchGeneration: number;
  dispatchPhase: TriggerAgentDispatchPhase;
  dispatchReceiptDigest: string;
  dispatchPayloadDigest: string;
  missionId: string | null;
  missionGroupId?: string;
  projectGroupId?: string;
  projectRepository?: string | null;
  schedulingGroupKey?: string;
  agentId: string | null;
  label: string;
  authorityDigest: string;
  workOrderRevisionDigest: string;
  triggerMachinePreset: TriggerAgentMachinePreset;
  triggerMachineReason: TriggerAgentMachineReason;
  reason: string;
};

function isDispatchReceiptReservation(value: unknown): value is AgentFleetReservation {
  const row = value as Partial<AgentFleetReservation> | null;
  return Boolean(row
    && typeof row.jobId === "string"
    && typeof row.dispatchId === "string"
    && Number.isSafeInteger(row.attempt) && Number(row.attempt) > 0
    && row.expectedAttempt === row.attempt
    && Number.isSafeInteger(row.dispatchGeneration) && Number(row.dispatchGeneration) > 0
    && ["specialist", "delivery", "integration"].includes(String(row.dispatchPhase))
    && /^[0-9a-f]{64}$/.test(String(row.dispatchReceiptDigest ?? ""))
    && /^[0-9a-f]{64}$/.test(String(row.dispatchPayloadDigest ?? ""))
    && /^[0-9a-f]{64}$/.test(String(row.authorityDigest ?? ""))
    && /^[0-9a-f]{64}$/.test(String(row.workOrderRevisionDigest ?? ""))
    && ["medium-1x", "medium-2x"].includes(String(row.triggerMachinePreset))
    && typeof row.triggerMachineReason === "string"
    && typeof row.reason === "string");
}

/**
 * Reserve the exact Convex-owned work envelopes without choosing an execution
 * transport. Trigger and the self-hosted controller both consume this single
 * authority boundary; neither transport may manufacture a job payload.
 */
export async function reserveAgentFleetBatch(
  reason: string,
  fanOut = DEFAULT_FAN_OUT,
  options: { createdAtFloor?: number } = {},
): Promise<AgentFleetReservation[]> {
  const cleanReason = reason.trim().replace(/\s+/g, " ").slice(0, 160) || "work-available";
  const limit = Math.max(1, Math.min(BACKGROUND_CONCURRENCY_LIMIT, Math.floor(fanOut)));
  const reserved = await workerMutation<{ reservations?: unknown[] }>("jobs:reserveDispatchBatch", {
    limit,
    reason: cleanReason,
    ...(options.createdAtFloor === undefined ? {} : { createdAtFloor: options.createdAtFloor }),
  });
  const offered = Array.isArray(reserved?.reservations) ? reserved.reservations : [];
  const reservations = offered.filter(isDispatchReceiptReservation);
  const held = offered.filter((reservation) => !isDispatchReceiptReservation(reservation)) as Array<Record<string, unknown>>;
  if (held.length) {
    // Convex-first is safe because old workers are held by claim validation.
    // A newer transport against old Convex releases only the legacy envelope
    // and waits for the receipt schema/code rather than guessing authority.
    await Promise.all(held.map((reservation) =>
      typeof reservation?.jobId === "string" && typeof reservation?.dispatchId === "string"
        ? workerMutation("jobs:rejectDispatch", {
          jobId: reservation.jobId,
          dispatchId: reservation.dispatchId,
          reason: "dispatch receipt protocol v2 is not active",
          delayMs: 60_000,
        }).catch(() => false)
        : Promise.resolve(false),
    ));
  }
  return reservations;
}

function safeTag(prefix: string, value: string): string {
  return `${prefix}:${value}`.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 64);
}

async function workerMutation<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Fleet dispatch mutation ${path} failed`);
  }
  return payload?.value as T;
}

/**
 * Reserve disjoint runnable jobs in Convex, then fan each one out as its own
 * Trigger.dev run. The reservation mutation is the concurrency authority; an
 * arbitrary number of routes and supervisors can call this safely at once.
 */
export async function wakeAgentFleet(reason: string, fanOut = DEFAULT_FAN_OUT): Promise<boolean> {
  const reservations = await reserveAgentFleetBatch(reason, fanOut);
  if (!reservations.length) return false;

  try {
    const launches = await Promise.all(reservations.map(async (reservation) => ({
      reservation,
      idempotencyKey: await idempotencyKeys.create(triggerAgentIdempotencyMaterial({
        jobId: reservation.jobId,
        attempt: reservation.attempt,
        dispatchGeneration: reservation.dispatchGeneration,
        dispatchPhase: reservation.dispatchPhase,
        dispatchReceiptDigest: reservation.dispatchReceiptDigest,
        authorityDigest: reservation.authorityDigest,
        workOrderRevisionDigest: reservation.workOrderRevisionDigest,
      }), { scope: "global" }),
    })));
    await tasks.batchTrigger<typeof agentWorker>(
      "jarvis-agent-worker",
      launches.map(({ reservation, idempotencyKey }) => ({
        payload: {
          jobId: reservation.jobId,
          dispatchId: reservation.dispatchId,
          expectedAttempt: reservation.expectedAttempt,
          dispatchGeneration: reservation.dispatchGeneration,
          dispatchPhase: reservation.dispatchPhase,
          dispatchReceiptDigest: reservation.dispatchReceiptDigest,
          dispatchPayloadDigest: reservation.dispatchPayloadDigest,
          authorityDigest: reservation.authorityDigest,
          workOrderRevisionDigest: reservation.workOrderRevisionDigest,
          triggerMachinePreset: reservation.triggerMachinePreset,
          triggerMachineReason: reservation.triggerMachineReason,
          reason: reservation.reason,
        },
        options: {
          idempotencyKey,
          idempotencyKeyTTL: TRIGGER_AGENT_IDEMPOTENCY_TTL,
          machine: reservation.triggerMachinePreset,
          tags: [
            "jarvis-agent",
            safeTag("job", reservation.jobId),
            ...(reservation.missionId ? [safeTag("mission", reservation.missionId)] : []),
            ...(reservation.agentId ? [safeTag("agent", reservation.agentId)] : []),
          ],
          metadata: {
            jobId: reservation.jobId,
            missionId: reservation.missionId,
            missionGroupId: reservation.missionGroupId ?? null,
            projectGroupId: reservation.projectGroupId ?? null,
            projectRepository: reservation.projectRepository ?? null,
            agentId: reservation.agentId,
            label: reservation.label.slice(0, 120),
            reason: reservation.reason,
            authorityDigest: reservation.authorityDigest,
            workOrderRevisionDigest: reservation.workOrderRevisionDigest,
            dispatchGeneration: reservation.dispatchGeneration,
            dispatchPhase: reservation.dispatchPhase,
            dispatchReceiptDigest: reservation.dispatchReceiptDigest,
            dispatchPayloadDigest: reservation.dispatchPayloadDigest,
            machinePreset: reservation.triggerMachinePreset,
            machineReason: reservation.triggerMachineReason,
            stage: "dispatching",
            percent: 1,
          },
          maxAttempts: 2,
        },
      })),
    );
    return true;
  } catch (error) {
    // A transport error can be ambiguous after a batch is accepted. Keep the
    // reservation reconciling until the lease reaper observes it; a retry uses
    // the same global immutable-attempt key and cannot create a second run.
    await Promise.all(
      reservations.map((reservation) =>
        workerMutation("jobs:markDispatchLaunchUnknown", {
          jobId: reservation.jobId,
          dispatchId: reservation.dispatchId,
          dispatchGeneration: reservation.dispatchGeneration,
          dispatchPhase: reservation.dispatchPhase,
          dispatchReceiptDigest: reservation.dispatchReceiptDigest,
          dispatchPayloadDigest: reservation.dispatchPayloadDigest,
          reason: `Trigger launch failed: ${String(error).slice(0, 220)}`,
        }).catch(() => false),
      ),
    );
    return false;
  }
}
