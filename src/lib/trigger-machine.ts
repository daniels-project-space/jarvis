export const TRIGGER_AGENT_MACHINE_PRESETS = ["medium-1x", "medium-2x"] as const;
export type TriggerAgentMachinePreset = (typeof TRIGGER_AGENT_MACHINE_PRESETS)[number];

export const TRIGGER_AGENT_MACHINE_REASONS = [
  "admitted_bounded_read",
  "admitted_write_or_hard",
  "trigger_oom_retry_escalation",
] as const;
export type TriggerAgentMachineReason = (typeof TRIGGER_AGENT_MACHINE_REASONS)[number];

export const TRIGGER_AGENT_IDEMPOTENCY_TTL = "30d";

export const TRIGGER_AGENT_DISPATCH_PHASES = [
  "specialist",
  "delivery",
  "integration",
] as const;
export type TriggerAgentDispatchPhase = (typeof TRIGGER_AGENT_DISPATCH_PHASES)[number];

export function admittedTriggerMachine(order: {
  readonly: boolean;
  minimumModel: string;
  minimumReasoningEffort: string;
}): Readonly<{ preset: TriggerAgentMachinePreset; reason: TriggerAgentMachineReason }> {
  const hard = order.minimumModel === "sol"
    || order.minimumReasoningEffort === "high"
    || order.minimumReasoningEffort === "max";
  return hard || !order.readonly
    ? { preset: "medium-2x", reason: "admitted_write_or_hard" }
    : { preset: "medium-1x", reason: "admitted_bounded_read" };
}

export function triggerAgentIdempotencyMaterial(input: {
  jobId: string;
  attempt: number;
  dispatchGeneration: number;
  dispatchPhase: TriggerAgentDispatchPhase;
  dispatchReceiptDigest: string;
  authorityDigest: string;
  workOrderRevisionDigest: string;
}): string[] {
  return [
    "jarvis-agent-dispatch-v2",
    input.jobId,
    String(input.attempt),
    String(input.dispatchGeneration),
    input.dispatchPhase,
    input.dispatchReceiptDigest,
    input.authorityDigest,
    input.workOrderRevisionDigest,
  ];
}

export function triggerClaimAuthority(input: {
  attempt: number;
  dispatchGeneration: number;
  dispatchPhase: TriggerAgentDispatchPhase;
  dispatchReceiptDigest: string;
  dispatchPayloadDigest: string;
  authorityDigest: string;
  workOrderRevisionDigest: string;
  triggerMachinePreset: TriggerAgentMachinePreset;
  triggerMachineReason: TriggerAgentMachineReason;
}, actualPreset: TriggerAgentMachinePreset = input.triggerMachinePreset, triggerPlatformAttempt = 1) {
  return {
    expectedAttempt: input.attempt,
    dispatchGeneration: input.dispatchGeneration,
    dispatchPhase: input.dispatchPhase,
    dispatchReceiptDigest: input.dispatchReceiptDigest,
    dispatchPayloadDigest: input.dispatchPayloadDigest,
    authorityDigest: input.authorityDigest,
    workOrderRevisionDigest: input.workOrderRevisionDigest,
    triggerMachinePreset: input.triggerMachinePreset,
    triggerMachineReason: input.triggerMachineReason,
    triggerObservedMachinePreset: actualPreset,
    triggerPlatformAttempt,
  };
}

export function observedTriggerMachineReason(input: {
  admittedPreset: TriggerAgentMachinePreset;
  admittedReason: TriggerAgentMachineReason;
  actualPreset: string;
  triggerAttempt: number;
}): TriggerAgentMachineReason | null {
  if (input.actualPreset === input.admittedPreset) return input.admittedReason;
  if (input.admittedPreset === "medium-1x"
    && input.actualPreset === "medium-2x"
    && input.triggerAttempt > 1) return "trigger_oom_retry_escalation";
  return null;
}
