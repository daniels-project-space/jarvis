export type MissionProtocolPhase = "dormant" | "active" | "rollback";
export type AdmissionMutationKind = "mission" | "job" | "goal";

const V1_MUTATIONS: Record<AdmissionMutationKind, string> = {
  mission: "missions:create",
  job: "jobs:enqueue",
  goal: "goalMode:create",
};

const V2_MUTATIONS: Record<AdmissionMutationKind, string> = {
  mission: "missions:createV2",
  job: "jobs:enqueueV2",
  goal: "goalMode:createV2",
};

export function missionProtocolPhase(value = process.env.JARVIS_MISSION_PROTOCOL_ROLLOUT): MissionProtocolPhase {
  return value === "active" ? "active" : value === "rollback" ? "rollback" : "dormant";
}

/**
 * The application release may safely precede the additive Convex release:
 * dormant/rollback callers use only the historical function names and shapes.
 */
export function admissionMutationName(
  kind: AdmissionMutationKind,
  phase: MissionProtocolPhase = missionProtocolPhase(),
) {
  return phase === "active" ? V2_MUTATIONS[kind] : V1_MUTATIONS[kind];
}

export function v2AdmissionEnabled(phase: MissionProtocolPhase = missionProtocolPhase()) {
  return phase === "active";
}

export type RolloutReadiness = Readonly<{
  phase: MissionProtocolPhase;
  v2ConvexAvailable: boolean;
  v2WorkersReady: boolean;
  legacyExecutableJobs: number;
}>;

export function rolloutReadiness(input: RolloutReadiness) {
  if (input.phase !== "active") return { executableV2: false, reason: input.phase } as const;
  if (!input.v2ConvexAvailable) return { executableV2: false, reason: "convex_v2_unavailable" } as const;
  if (!input.v2WorkersReady) return { executableV2: false, reason: "workers_v2_unavailable" } as const;
  if (input.legacyExecutableJobs > 0) return { executableV2: false, reason: "legacy_drain_incomplete" } as const;
  return { executableV2: true, reason: "active" } as const;
}
