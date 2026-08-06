import {
  idempotencyKeys,
  tasks,
  type IdempotencyKey,
} from "@trigger.dev/sdk/v3";

import {
  MISSION_SUPERVISOR_TICK_TASK_ID,
  missionSupervisorDispatchIdentity,
  parseMissionSupervisorWakeTicket,
  type MissionSupervisorTickPayload,
} from "./mission-supervisor-dispatch";
import { missionSupervisorRolloutMode } from "./mission-supervisor-orchestration";

type MissionSupervisorTriggerOptions = {
  idempotencyKey: IdempotencyKey;
  idempotencyKeyTTL: "1m";
  concurrencyKey: string;
  tags: string[];
};

export type MissionSupervisorTriggerHandle = {
  id: string;
  [key: string]: unknown;
};

export interface MissionSupervisorServerDispatchDependencies {
  isConfigured(): boolean;
  createIdempotencyKey(
    material: string,
    options: { scope: "global" },
  ): Promise<IdempotencyKey>;
  triggerTick(
    taskId: typeof MISSION_SUPERVISOR_TICK_TASK_ID,
    payload: MissionSupervisorTickPayload,
    options: MissionSupervisorTriggerOptions,
  ): Promise<MissionSupervisorTriggerHandle>;
}

export type MissionSupervisorWakeDispatchResult =
  | {
      dispatched: false;
      reason: "no_wake_ticket" | "supervisor_rollout_disabled";
    }
  | {
      dispatched: true;
      runId: string;
      handle: MissionSupervisorTriggerHandle;
      payload: MissionSupervisorTickPayload;
      idempotencyKey: string;
    };

export class MissionSupervisorServerDispatchError extends Error {
  readonly code:
    | "trigger_not_configured"
    | "trigger_dispatch_failed"
    | "invalid_trigger_handle";

  constructor(
    code: MissionSupervisorServerDispatchError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MissionSupervisorServerDispatchError";
    this.code = code;
  }
}

function productionDependencies(): MissionSupervisorServerDispatchDependencies {
  return {
    isConfigured: () =>
      Boolean(process.env.TRIGGER_SECRET_KEY?.trim()),
    createIdempotencyKey: (material, options) =>
      idempotencyKeys.create(material, options),
    triggerTick: async (taskId, payload, options) =>
      await tasks.trigger(taskId, payload, options),
  };
}

export function missionSupervisorDispatchEnabled(): boolean {
  const mode = missionSupervisorRolloutMode();
  return mode === "active" || mode === "canary";
}

/**
 * Dispatch an exact wake ticket through a stable one-minute Trigger identity.
 *
 * This implementation is shared by Next server routes and Trigger workers.
 * `null` means Convex deliberately requested no immediate wake. Dormant and
 * rollback releases return before ticket validation or Trigger setup; malformed
 * values throw before Trigger is touched only when the rollout is enabled.
 */
export async function dispatchMissionSupervisorWakeTicket(
  value: unknown,
  dependencies: MissionSupervisorServerDispatchDependencies =
    productionDependencies(),
): Promise<MissionSupervisorWakeDispatchResult> {
  if (value === null) {
    return { dispatched: false, reason: "no_wake_ticket" };
  }
  if (!missionSupervisorDispatchEnabled()) {
    return { dispatched: false, reason: "supervisor_rollout_disabled" };
  }
  const payload = parseMissionSupervisorWakeTicket(value);
  if (!dependencies.isConfigured()) {
    throw new MissionSupervisorServerDispatchError(
      "trigger_not_configured",
      "TRIGGER_SECRET_KEY is not configured for mission supervisor dispatch",
    );
  }
  const identity = missionSupervisorDispatchIdentity(payload);
  try {
    const idempotencyKey = await dependencies.createIdempotencyKey(
      identity.idempotencyKey,
      { scope: identity.idempotencyKeyScope },
    );
    const handle = await dependencies.triggerTick(
      MISSION_SUPERVISOR_TICK_TASK_ID,
      payload,
      {
        idempotencyKey,
        idempotencyKeyTTL: identity.idempotencyKeyTTL,
        concurrencyKey: identity.concurrencyKey,
        tags: identity.tags,
      },
    );
    if (!handle || typeof handle.id !== "string" || !handle.id.trim()) {
      throw new MissionSupervisorServerDispatchError(
        "invalid_trigger_handle",
        "Trigger accepted mission supervisor dispatch without a run identity",
      );
    }
    return {
      dispatched: true,
      runId: handle.id,
      handle,
      payload,
      idempotencyKey: identity.idempotencyKey,
    };
  } catch (error) {
    if (error instanceof MissionSupervisorServerDispatchError) throw error;
    throw new MissionSupervisorServerDispatchError(
      "trigger_dispatch_failed",
      "Mission supervisor Trigger dispatch failed ambiguously",
      { cause: error },
    );
  }
}
