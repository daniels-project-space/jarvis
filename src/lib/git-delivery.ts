export type GitDeliveryDisposition = "noop" | "push" | "reconcile";

export function gitDeliveryDisposition(args: {
  baseSha: string;
  localSha: string;
  remoteSha?: string;
}): GitDeliveryDisposition {
  const base = args.baseSha.trim();
  const local = args.localSha.trim();
  const remote = args.remoteSha?.trim() ?? "";
  if (!local || (base && local === base) || (remote && local === remote)) return "noop";
  if (!remote || (base && remote === base)) return "push";
  return "reconcile";
}

export function isNonFastForwardPush(output: string): boolean {
  return /non-fast-forward|fetch first|failed to push some refs|tip of your current branch is behind/i.test(output);
}
