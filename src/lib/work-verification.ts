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
