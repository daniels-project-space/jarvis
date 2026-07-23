import { createHash } from "node:crypto";

import { z } from "zod";

export const MISSION_SUPERVISOR_TICK_TASK_ID =
  "jarvis-mission-supervisor-tick";
export const MISSION_SUPERVISOR_IDEMPOTENCY_KEY_TTL = "1m" as const;
export const MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE = "global" as const;

const SAFE_MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const nonNegativeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();

const missionSupervisorWakeTicketSchema = z.object({
  protocolVersion: z.literal(1),
  missionId: z.string().max(160).regex(SAFE_MISSION_ID),
  expectedLeaseVersion: nonNegativeInteger,
  expectedEpoch: positiveInteger,
  expectedDecisionSequence: positiveInteger,
  expectedInputRevision: nonNegativeInteger,
}).strict();

export type MissionSupervisorWakeTicket = z.infer<
  typeof missionSupervisorWakeTicketSchema
>;
export type MissionSupervisorTickPayload = MissionSupervisorWakeTicket;

export type MissionSupervisorDispatchOptions = {
  idempotencyKey: string;
  idempotencyKeyTTL: typeof MISSION_SUPERVISOR_IDEMPOTENCY_KEY_TTL;
  idempotencyKeyScope: typeof MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE;
  concurrencyKey: string;
  tags: string[];
};

export class MissionSupervisorDispatchContractError extends Error {
  readonly code = "invalid_payload";

  constructor() {
    super("Mission supervisor tick payload is invalid");
    this.name = "MissionSupervisorDispatchContractError";
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Parse the exact Convex start/control wake ticket. Extra fields are rejected
 * so a transport envelope can never be mistaken for Trigger task authority.
 */
export function parseMissionSupervisorWakeTicket(
  value: unknown,
): MissionSupervisorWakeTicket {
  const parsed = missionSupervisorWakeTicketSchema.safeParse(value);
  if (!parsed.success) throw new MissionSupervisorDispatchContractError();
  return parsed.data;
}

export const parseMissionSupervisorTickPayload =
  parseMissionSupervisorWakeTicket;

/**
 * Derive every dispatch fence from the immutable wake ticket. The raw key is
 * stable across callers and retries; SDK-specific global-key materialization
 * remains at the dispatch boundary.
 */
export function missionSupervisorDispatchIdentity(
  value: unknown,
): MissionSupervisorDispatchOptions {
  const ticket = parseMissionSupervisorWakeTicket(value);
  const material = [
    ticket.missionId,
    ticket.expectedEpoch,
    ticket.expectedDecisionSequence,
    ticket.expectedInputRevision,
    ticket.expectedLeaseVersion,
  ].join(":");
  const digest = sha256Hex(material);
  const missionDigest = sha256Hex(ticket.missionId);
  return {
    idempotencyKey: `mission-supervisor:${digest}`,
    idempotencyKeyTTL: MISSION_SUPERVISOR_IDEMPOTENCY_KEY_TTL,
    idempotencyKeyScope: MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE,
    concurrencyKey: `mission-supervisor:${missionDigest.slice(0, 32)}`,
    tags: [
      "mission-supervisor",
      `mission:${missionDigest.slice(0, 24)}`,
    ],
  };
}
