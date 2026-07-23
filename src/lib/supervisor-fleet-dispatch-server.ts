import "server-only";

import {
  idempotencyKeys,
  tasks,
  type IdempotencyKey,
} from "@trigger.dev/sdk/v3";
import type { agentWorker } from "../trigger/agent-runner";
import { resolveConvexUrl } from "./convex-url";
import {
  TRIGGER_AGENT_IDEMPOTENCY_TTL,
  TRIGGER_AGENT_MACHINE_REASONS,
  triggerAgentIdempotencyMaterial,
  type TriggerAgentDispatchPhase,
  type TriggerAgentMachinePreset,
  type TriggerAgentMachineReason,
} from "./trigger-machine";

const CONVEX_URL = resolveConvexUrl(
  process.env.CONVEX_URL,
  process.env.NEXT_PUBLIC_CONVEX_URL,
);
const TARGETED_RESERVATION_PATH =
  "jobs:reserveSupervisorControlDispatchBatchV1";

export type SupervisorFleetWakeTicket = {
  protocolVersion: 1;
  controlReceiptId: string;
};

type Reservation = {
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

type ReservationBatch = {
  protocolVersion: 1;
  status:
    | "reserved"
    | "already_inflight"
    | "already_advanced"
    | "fallback_pending"
    | "capacity_limited"
    | "invalid_manifest"
    | "stale_manifest"
    | "invalid_scheduler_authority";
  reservations: Reservation[];
};

type TriggerBatchItem = {
  payload: {
    jobId: string;
    dispatchId: string;
    expectedAttempt: number;
    dispatchGeneration: number;
    dispatchPhase: TriggerAgentDispatchPhase;
    dispatchReceiptDigest: string;
    dispatchPayloadDigest: string;
    authorityDigest: string;
    workOrderRevisionDigest: string;
    triggerMachinePreset: TriggerAgentMachinePreset;
    triggerMachineReason: TriggerAgentMachineReason;
    reason: string;
  };
  options: {
    idempotencyKey: IdempotencyKey;
    idempotencyKeyTTL: typeof TRIGGER_AGENT_IDEMPOTENCY_TTL;
    machine: TriggerAgentMachinePreset;
    tags: string[];
    metadata: Record<string, string | number | null>;
    maxAttempts: 2;
  };
};

export interface SupervisorFleetDispatchDependencies {
  reserveBatch(controlReceiptId: string): Promise<unknown>;
  markLaunchUnknown(reservation: Reservation, reason: string): Promise<unknown>;
  createIdempotencyKey(
    material: string[],
    options: { scope: "global" },
  ): Promise<IdempotencyKey>;
  triggerBatch(
    taskId: "jarvis-agent-worker",
    items: TriggerBatchItem[],
  ): Promise<unknown>;
}

export type SupervisorFleetDispatchResult = {
  status: "held" | "dispatched" | "reconciling";
  offeredCount: number;
};

export class SupervisorFleetReservationTransportError extends Error {
  readonly code = "reservation_transport_unknown";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SupervisorFleetReservationTransportError";
  }
}

function safeTag(prefix: string, value: string): string {
  return `${prefix}:${value}`
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .slice(0, 64);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function reservation(value: unknown): Reservation | null {
  const row = value as Partial<Reservation> | null;
  if (
    !row
    || typeof row.jobId !== "string"
    || !row.jobId
    || typeof row.dispatchId !== "string"
    || !row.dispatchId
    || !Number.isSafeInteger(row.attempt)
    || Number(row.attempt) < 1
    || row.expectedAttempt !== row.attempt
    || !Number.isSafeInteger(row.dispatchGeneration)
    || Number(row.dispatchGeneration) < 1
    || !["specialist", "delivery"]
      .includes(String(row.dispatchPhase))
    || !isDigest(row.dispatchReceiptDigest)
    || !isDigest(row.dispatchPayloadDigest)
    || !isDigest(row.authorityDigest)
    || !isDigest(row.workOrderRevisionDigest)
    || !["medium-1x", "medium-2x"]
      .includes(String(row.triggerMachinePreset))
    || !(TRIGGER_AGENT_MACHINE_REASONS as readonly string[])
      .includes(String(row.triggerMachineReason))
    || typeof row.reason !== "string"
    || typeof row.label !== "string"
    || !(row.missionId === null || typeof row.missionId === "string")
    || !(row.agentId === null || typeof row.agentId === "string")
    || row.dispatchId
      !== `${row.jobId}:${row.attempt}:${row.dispatchGeneration}:${row.dispatchPhase}`
  ) {
    return null;
  }
  return {
    jobId: row.jobId,
    dispatchId: row.dispatchId,
    attempt: Number(row.attempt),
    expectedAttempt: Number(row.expectedAttempt),
    dispatchGeneration: Number(row.dispatchGeneration),
    dispatchPhase: row.dispatchPhase as TriggerAgentDispatchPhase,
    dispatchReceiptDigest: row.dispatchReceiptDigest,
    dispatchPayloadDigest: row.dispatchPayloadDigest,
    missionId: row.missionId,
    ...(typeof row.missionGroupId === "string"
      ? { missionGroupId: row.missionGroupId }
      : {}),
    ...(typeof row.projectGroupId === "string"
      ? { projectGroupId: row.projectGroupId }
      : {}),
    ...(row.projectRepository === null
      || typeof row.projectRepository === "string"
      ? { projectRepository: row.projectRepository }
      : {}),
    ...(typeof row.schedulingGroupKey === "string"
      ? { schedulingGroupKey: row.schedulingGroupKey }
      : {}),
    agentId: row.agentId,
    label: row.label,
    authorityDigest: row.authorityDigest,
    workOrderRevisionDigest: row.workOrderRevisionDigest,
    triggerMachinePreset:
      row.triggerMachinePreset as TriggerAgentMachinePreset,
    triggerMachineReason:
      row.triggerMachineReason as TriggerAgentMachineReason,
    reason: row.reason,
  };
}

function reservationBatch(value: unknown): ReservationBatch | null {
  const row = value as {
    protocolVersion?: unknown;
    status?: unknown;
    reservations?: unknown;
  } | null;
  const statuses: ReservationBatch["status"][] = [
    "reserved",
    "already_inflight",
    "already_advanced",
    "fallback_pending",
    "capacity_limited",
    "invalid_manifest",
    "stale_manifest",
    "invalid_scheduler_authority",
  ];
  if (
    !row
    || row.protocolVersion !== 1
    || !statuses.includes(row.status as ReservationBatch["status"])
    || !Array.isArray(row.reservations)
    || row.reservations.length > 24
  ) {
    return null;
  }
  const parsed = row.reservations.map(reservation);
  const reservationCount = row.reservations.length;
  const status = row.status as ReservationBatch["status"];
  const statusAllowsReservations = status === "reserved"
    || status === "capacity_limited";
  if (
    parsed.some((item) => item === null)
    || new Set(parsed.map((item) => item!.jobId)).size !== parsed.length
    || (!statusAllowsReservations && reservationCount !== 0)
    || (status === "reserved" && reservationCount === 0)
  ) {
    return null;
  }
  return {
    protocolVersion: 1,
    status,
    reservations: parsed as Reservation[],
  };
}

function parseTicket(value: unknown): SupervisorFleetWakeTicket {
  const ticket = value as Partial<SupervisorFleetWakeTicket> | null;
  if (
    !ticket
    || ticket.protocolVersion !== 1
    || typeof ticket.controlReceiptId !== "string"
    || !ticket.controlReceiptId
    || ticket.controlReceiptId.length > 160
    || Object.keys(ticket).some((key) =>
      key !== "protocolVersion" && key !== "controlReceiptId"
    )
  ) {
    throw new TypeError("Invalid supervisor fleet wake ticket");
  }
  return {
    protocolVersion: 1,
    controlReceiptId: ticket.controlReceiptId,
  };
}

async function workerMutation<T>(
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
  const workerToken = process.env.JARVIS_WORKER_TOKEN?.trim();
  if (!workerToken) {
    throw new Error("JARVIS_WORKER_TOKEN is not configured");
  }
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      args: { ...args, workerToken },
      format: "json",
    }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Fleet dispatch mutation ${path} failed`);
  }
  return payload?.value as T;
}

function productionDependencies(): SupervisorFleetDispatchDependencies {
  return {
    reserveBatch: async (controlReceiptId) =>
      await workerMutation(TARGETED_RESERVATION_PATH, {
        controlReceiptId,
      }),
    markLaunchUnknown: async (item, reason) =>
      await workerMutation("jobs:markDispatchLaunchUnknown", {
        jobId: item.jobId,
        dispatchId: item.dispatchId,
        dispatchGeneration: item.dispatchGeneration,
        dispatchPhase: item.dispatchPhase,
        dispatchReceiptDigest: item.dispatchReceiptDigest,
        dispatchPayloadDigest: item.dispatchPayloadDigest,
        reason,
      }),
    createIdempotencyKey: (material, options) =>
      idempotencyKeys.create(material, options),
    triggerBatch: async (taskId, items) =>
      await tasks.batchTrigger<typeof agentWorker>(taskId, items),
  };
}

function triggerItem(
  item: Reservation,
  idempotencyKey: IdempotencyKey,
): TriggerBatchItem {
  return {
    payload: {
      jobId: item.jobId,
      dispatchId: item.dispatchId,
      expectedAttempt: item.expectedAttempt,
      dispatchGeneration: item.dispatchGeneration,
      dispatchPhase: item.dispatchPhase,
      dispatchReceiptDigest: item.dispatchReceiptDigest,
      dispatchPayloadDigest: item.dispatchPayloadDigest,
      authorityDigest: item.authorityDigest,
      workOrderRevisionDigest: item.workOrderRevisionDigest,
      triggerMachinePreset: item.triggerMachinePreset,
      triggerMachineReason: item.triggerMachineReason,
      reason: item.reason,
    },
    options: {
      idempotencyKey,
      idempotencyKeyTTL: TRIGGER_AGENT_IDEMPOTENCY_TTL,
      machine: item.triggerMachinePreset,
      tags: [
        "jarvis-agent",
        safeTag("job", item.jobId),
        ...(item.missionId
          ? [safeTag("mission", item.missionId)]
          : []),
        ...(item.agentId ? [safeTag("agent", item.agentId)] : []),
      ],
      metadata: {
        jobId: item.jobId,
        missionId: item.missionId,
        missionGroupId: item.missionGroupId ?? null,
        projectGroupId: item.projectGroupId ?? null,
        projectRepository: item.projectRepository ?? null,
        agentId: item.agentId,
        label: item.label.slice(0, 120),
        reason: item.reason,
        authorityDigest: item.authorityDigest,
        workOrderRevisionDigest: item.workOrderRevisionDigest,
        dispatchGeneration: item.dispatchGeneration,
        dispatchPhase: item.dispatchPhase,
        dispatchReceiptDigest: item.dispatchReceiptDigest,
        dispatchPayloadDigest: item.dispatchPayloadDigest,
        machinePreset: item.triggerMachinePreset,
        machineReason: item.triggerMachineReason,
        stage: "dispatching",
        percent: 1,
      },
      maxAttempts: 2,
    },
  };
}

/**
 * Reserves and launches only the members sealed into one applied resume
 * control receipt. The browser receives only the coarse result; the ticket,
 * receipt digests, dispatch IDs, idempotency keys, and Trigger handle stay on
 * the server.
 */
export async function dispatchSupervisorFleetWakeTicket(
  value: unknown,
  dependencies: SupervisorFleetDispatchDependencies =
    productionDependencies(),
): Promise<SupervisorFleetDispatchResult> {
  const ticket = parseTicket(value);
  let rawBatch: unknown;
  try {
    rawBatch = await dependencies.reserveBatch(ticket.controlReceiptId);
  } catch (cause) {
    throw new SupervisorFleetReservationTransportError(
      "The receipt-bound reservation outcome is unknown",
      { cause },
    );
  }
  const batch = reservationBatch(rawBatch);
  if (!batch) {
    throw new SupervisorFleetReservationTransportError(
      "The receipt-bound reservation response is invalid",
    );
  }
  if (!batch.reservations.length) {
    return { status: "held", offeredCount: 0 };
  }

  try {
    const items = await Promise.all(batch.reservations.map(async (item) =>
      triggerItem(
        item,
        await dependencies.createIdempotencyKey(
          triggerAgentIdempotencyMaterial({
            jobId: item.jobId,
            attempt: item.attempt,
            dispatchGeneration: item.dispatchGeneration,
            dispatchPhase: item.dispatchPhase,
            dispatchReceiptDigest: item.dispatchReceiptDigest,
            authorityDigest: item.authorityDigest,
            workOrderRevisionDigest: item.workOrderRevisionDigest,
          }),
          { scope: "global" },
        ),
      )
    ));
    const handle = await dependencies.triggerBatch(
      "jarvis-agent-worker",
      items,
    ) as { batchId?: unknown; runCount?: unknown } | null;
    if (
      !handle
      || typeof handle.batchId !== "string"
      || !handle.batchId.trim()
      || !Number.isSafeInteger(handle.runCount)
      || handle.runCount !== batch.reservations.length
    ) {
      throw new Error("Trigger returned an incomplete fleet acceptance");
    }
    return {
      status: "dispatched",
      offeredCount: batch.reservations.length,
    };
  } catch (cause) {
    const reason =
      `Trigger launch acceptance unknown: ${String(cause).slice(0, 180)}`;
    const markings = await Promise.allSettled(batch.reservations.map((item) =>
      dependencies.markLaunchUnknown(item, reason)
    ));
    const allMarked = markings.every((marking) =>
      marking.status === "fulfilled" && marking.value === true
    );
    return {
      status: allMarked ? "reconciling" : "held",
      offeredCount: batch.reservations.length,
    };
  }
}
