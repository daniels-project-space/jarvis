export const WORK_VERIFICATION_EVIDENCE_MAX_CHARS = 8_000;

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
