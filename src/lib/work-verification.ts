export const WORK_VERIFICATION_EVIDENCE_MAX_CHARS = 8_000;

/**
 * Shared standard for both the fast workstream supervisor and the final deep
 * validator. It prevents a green build or a caller-supplied field from being
 * promoted into evidence that an external provider actually supplied data or
 * accepted an operation.
 */
export const EVIDENCE_INTEGRITY_RULES = [
  "Evidence integrity: a caller-supplied field or self-reported timestamp, ID, inventory count, cost, URL, environment value, screenshot, or agent claim is an assertion—not provider proof.",
  "For a claimed live pipeline, trace an upstream provider response or signed event through validation and persisted lineage into the exact downstream caller; exercise provider sandbox/test mode where it exists.",
  "A build, typecheck, mock, compile-time placeholder, or configured target proves only that boundary. It does not prove runtime provider state, a deployed revision, data provenance, or a user journey.",
  "Long-lived service authentication must be renewable or have an evidenced rotation path; a static expiring token is not launch-ready merely because it works today.",
].join(" ");

export function supervisorDeliveryBoundary(goalStage: unknown): string {
  return goalStage === "building" || goalStage === "refining"
    ? "This is one shared-branch Goal Mode implementation session. Judge its scoped definition of done. Do not return concerns solely because the branch is not merged/deployed or because goal-level provider validation remains: the final Release Proof, deep outcome validator, and trusted delivery controller own those later boundaries."
    : "";
}

/**
 * A continuation is one logical workstream, not a brand-new task. Preserve the
 * prior checkpoint when the supervisor reviews a repair pass so a concise
 * delta cannot make already-evidenced work look missing.
 */
export function cumulativeWorkEvidence(priorCheckpoint: unknown, currentResult: unknown): string {
  const prior = String(priorCheckpoint ?? "").trim();
  const current = String(currentResult ?? "").trim();
  if (!prior) return current.slice(0, WORK_VERIFICATION_EVIDENCE_MAX_CHARS);
  if (!current) return prior.slice(0, WORK_VERIFICATION_EVIDENCE_MAX_CHARS);
  return [
    `PRIOR CHECKPOINT EVIDENCE:\n${prior.slice(0, 4_500)}`,
    `CURRENT REPAIR-PASS EVIDENCE:\n${current.slice(0, 3_000)}`,
  ].join("\n\n").slice(0, WORK_VERIFICATION_EVIDENCE_MAX_CHARS);
}

export function isPermittedReadonlyAccessGap(input: {
  readonly: boolean;
  task: string;
  result: string;
}): boolean {
  if (!input.readonly) return false;
  const taskPermitsGap =
    /\bstop\b[\s\S]{0,100}\b(?:missing|unavailable|named)\b[\s\S]{0,50}\b(?:read\s+)?access\b/i.test(input.task)
    || /\bstop\b[\s\S]{0,100}\baccess gap\b/i.test(input.task);
  const resultNamesGap =
    /\b(?:missing|unavailable|blocked)\b[\s\S]{0,140}\b(?:access|capability)\b/i.test(input.result)
    || /\b(?:access|capability)\b[\s\S]{0,140}\b(?:missing|unavailable|blocked|required)\b/i.test(input.result);
  return taskPermitsGap && resultNamesGap;
}
