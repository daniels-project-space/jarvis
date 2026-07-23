import { sha256Hex } from "./source-admission";

export const SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION = 1 as const;
export const SUPERVISOR_FLEET_MANIFEST_MAX_MEMBERS = 24;

export type SupervisorFleetDispatchPhase = "specialist" | "delivery";

export type SupervisorFleetManifestMemberCore = Readonly<{
  protocolVersion: typeof SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION;
  jobId: string;
  workAttemptId: string;
  attempt: number;
  phase: SupervisorFleetDispatchPhase;
  authorityDigest: string;
  schedulingAdmissionId: string;
  schedulingBindingDigest: string;
  schedulingGroupKey: string;
  workOrderRevisionId: string;
  workOrderRevision: number;
  workOrderRevisionDigest: string;
  nextRunAt: number;
  priority: number;
  createdAt: number;
  writeLineage?: string;
  approvalId?: string;
  approvalResolvedAt?: number;
  deliveryAttemptId?: string;
  deliverySourceWorkAttempt?: number;
  deliveryGeneration?: number;
  reviewReceiptId?: string;
  reviewReceiptDigest?: string;
}>;

export type SupervisorFleetManifestMember =
  SupervisorFleetManifestMemberCore & Readonly<{
    memberDigest: string;
  }>;

export type SupervisorFleetManifestBinding = Readonly<{
  missionId: string;
  requestKey: string;
  requestDigest: string;
  expectedInputRevision: number;
  resultInputRevision: number;
  sourcePauseControlReceiptId: string;
}>;

export type SupervisorControlBatchDigestInput = Readonly<{
  missionId: string;
  action: "pause" | "resume";
  requestKey: string;
  requestDigest: string;
  expectedInputRevision: number;
  resultInputRevision: number;
  affectedJobIds: readonly string[];
  sourcePauseControlReceiptId?: string;
}>;

function canonicalJson(value: unknown): string {
  const counter = { nodes: 0 };
  const encode = (item: unknown, depth: number): string => {
    counter.nodes += 1;
    if (counter.nodes > 512 || depth > 8) {
      throw new Error("Supervisor fleet manifest exceeds structural bounds");
    }
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("Supervisor fleet manifest contains a non-finite number");
      }
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => {
        if (entry === undefined) {
          throw new Error("Supervisor fleet manifest arrays cannot contain undefined");
        }
        return encode(entry, depth + 1);
      }).join(",")}]`;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Supervisor fleet manifest must use plain objects");
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) =>
          `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`
        )
        .join(",")}}`;
    }
    throw new Error("Supervisor fleet manifest contains an unsupported value");
  };
  return encode(value, 0);
}

function normalizedMember(member: SupervisorFleetManifestMemberCore) {
  return {
    protocolVersion: member.protocolVersion,
    jobId: member.jobId,
    workAttemptId: member.workAttemptId,
    attempt: member.attempt,
    phase: member.phase,
    authorityDigest: member.authorityDigest,
    schedulingAdmissionId: member.schedulingAdmissionId,
    schedulingBindingDigest: member.schedulingBindingDigest,
    schedulingGroupKey: member.schedulingGroupKey,
    workOrderRevisionId: member.workOrderRevisionId,
    workOrderRevision: member.workOrderRevision,
    workOrderRevisionDigest: member.workOrderRevisionDigest,
    nextRunAt: member.nextRunAt,
    priority: member.priority,
    createdAt: member.createdAt,
    writeLineage: member.writeLineage ?? null,
    approvalId: member.approvalId ?? null,
    approvalResolvedAt: member.approvalResolvedAt ?? null,
    deliveryAttemptId: member.deliveryAttemptId ?? null,
    deliverySourceWorkAttempt: member.deliverySourceWorkAttempt ?? null,
    deliveryGeneration: member.deliveryGeneration ?? null,
    reviewReceiptId: member.reviewReceiptId ?? null,
    reviewReceiptDigest: member.reviewReceiptDigest ?? null,
  };
}

export async function canonicalSupervisorControlBatchDigest(
  input: SupervisorControlBatchDigestInput,
): Promise<string> {
  const affectedJobIds = [...input.affectedJobIds].sort((left, right) =>
    left.localeCompare(right)
  );
  if (
    affectedJobIds.length > SUPERVISOR_FLEET_MANIFEST_MAX_MEMBERS
    || new Set(affectedJobIds).size !== affectedJobIds.length
  ) {
    throw new Error("Supervisor control batch membership is invalid");
  }
  return await sha256Hex(canonicalJson({
    protocolVersion: 1,
    missionId: input.missionId,
    action: input.action,
    requestKey: input.requestKey,
    requestDigest: input.requestDigest,
    expectedInputRevision: input.expectedInputRevision,
    resultInputRevision: input.resultInputRevision,
    affectedJobIds,
    sourcePauseControlReceiptId:
      input.sourcePauseControlReceiptId ?? null,
  }));
}

export async function supervisorFleetMemberDigest(
  member: SupervisorFleetManifestMemberCore,
): Promise<string> {
  return await sha256Hex(canonicalJson(normalizedMember(member)));
}

export async function sealSupervisorFleetManifestMember(
  member: SupervisorFleetManifestMemberCore,
): Promise<SupervisorFleetManifestMember> {
  return {
    ...member,
    memberDigest: await supervisorFleetMemberDigest(member),
  };
}

export function canonicalSupervisorFleetManifestMembers(
  members: readonly SupervisorFleetManifestMember[],
): SupervisorFleetManifestMember[] {
  if (members.length > SUPERVISOR_FLEET_MANIFEST_MAX_MEMBERS) {
    throw new Error("Supervisor fleet manifest exceeds its member bound");
  }
  const sorted = [...members].sort((left, right) =>
    left.jobId.localeCompare(right.jobId)
  );
  if (
    new Set(sorted.map((member) => member.jobId)).size !== sorted.length
    || new Set(sorted.map((member) => member.memberDigest)).size !== sorted.length
  ) {
    throw new Error("Supervisor fleet manifest contains duplicate authority");
  }
  return sorted;
}

export async function supervisorFleetManifestDigest(
  binding: SupervisorFleetManifestBinding,
  members: readonly SupervisorFleetManifestMember[],
): Promise<string> {
  const canonical = canonicalSupervisorFleetManifestMembers(members);
  return await sha256Hex(canonicalJson({
    protocolVersion: SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION,
    missionId: binding.missionId,
    requestKey: binding.requestKey,
    requestDigest: binding.requestDigest,
    expectedInputRevision: binding.expectedInputRevision,
    resultInputRevision: binding.resultInputRevision,
    sourcePauseControlReceiptId: binding.sourcePauseControlReceiptId,
    memberCount: canonical.length,
    members: canonical.map((member) => ({
      jobId: member.jobId,
      memberDigest: member.memberDigest,
    })),
  }));
}

export async function validSupervisorFleetManifest(args: {
  binding: SupervisorFleetManifestBinding;
  members: readonly SupervisorFleetManifestMember[];
  memberCount: number;
  fleetDigest: string;
}): Promise<boolean> {
  if (
    !Number.isSafeInteger(args.memberCount)
    || args.memberCount < 0
    || args.memberCount > SUPERVISOR_FLEET_MANIFEST_MAX_MEMBERS
    || args.members.length !== args.memberCount
    || !/^[0-9a-f]{64}$/.test(args.fleetDigest)
  ) {
    return false;
  }
  let canonical: SupervisorFleetManifestMember[];
  try {
    canonical = canonicalSupervisorFleetManifestMembers(args.members);
  } catch {
    return false;
  }
  if (
    canonical.some((member, index) =>
      member.jobId !== args.members[index]?.jobId
    )
  ) {
    return false;
  }
  for (const member of canonical) {
    if (
      member.protocolVersion !== SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION
      || !/^[0-9a-f]{64}$/.test(member.memberDigest)
      || member.memberDigest !== await supervisorFleetMemberDigest(member)
    ) {
      return false;
    }
  }
  return args.fleetDigest
    === await supervisorFleetManifestDigest(args.binding, canonical);
}
