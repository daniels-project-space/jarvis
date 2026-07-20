export type GitDeliveryDisposition = "noop" | "push" | "reconcile";

export const SHALLOW_PROVENANCE_RULE = "Shallow history is not evidence of parentless provenance.";

export type GitCommandResult = { code: number | null; out: string };
export type GitCommandRunner = (args: string[]) => Promise<GitCommandResult>;

export type GitHistoryReadiness = {
  ok: boolean;
  hydrated: boolean;
  note: string;
};

export type SharedBranchReconciliation = {
  status: "ready" | "already_delivered" | "retry";
  localSha: string;
  rebased: boolean;
  note: string;
};

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

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(-240);
}

/**
 * A depth-limited clone deliberately hides parents from revision walking even
 * though the commit object still names them. Hydrate the exact source branch
 * before either an agent or the delivery controller makes a lineage decision.
 */
export async function ensureCompleteRepositoryHistory(args: {
  runGit: GitCommandRunner;
  remote: string;
  sourceBranch: string;
}): Promise<GitHistoryReadiness> {
  const shallow = await args.runGit(["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0) {
    return {
      ok: false,
      hydrated: false,
      note: `could not inspect repository depth: ${oneLine(shallow.out) || "git rev-parse failed"}`,
    };
  }
  if (shallow.out.trim() === "false") {
    return { ok: true, hydrated: false, note: "repository history is complete" };
  }
  if (shallow.out.trim() !== "true" || !args.sourceBranch.trim()) {
    return {
      ok: false,
      hydrated: false,
      note: "repository depth or its exact source branch could not be determined",
    };
  }

  const sourceRef = `refs/heads/${args.sourceBranch}`;
  const hydratedRef = "refs/remotes/jarvis-lineage/source";
  const fetch = await args.runGit([
    "fetch",
    "--no-tags",
    "--unshallow",
    args.remote,
    `+${sourceRef}:${hydratedRef}`,
  ]);
  if (fetch.code !== 0) {
    return {
      ok: false,
      hydrated: false,
      note: `could not hydrate exact ancestry for ${args.sourceBranch}: ${oneLine(fetch.out) || "git fetch failed"}`,
    };
  }

  const verified = await args.runGit(["rev-parse", "--is-shallow-repository"]);
  if (verified.code !== 0 || verified.out.trim() !== "false") {
    return {
      ok: false,
      hydrated: false,
      note: `ancestry for ${args.sourceBranch} remains shallow after hydration`,
    };
  }
  return { ok: true, hydrated: true, note: `hydrated exact ancestry for ${args.sourceBranch}` };
}

/** Returns null when Git cannot make a trustworthy ancestry determination. */
export async function gitCommitIsAncestor(
  runGit: GitCommandRunner,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  if (!ancestor.trim() || !descendant.trim()) return null;
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return null;
}

/**
 * Reconcile local work with the canonical shared branch without force pushing.
 * The recorded base must be present in both histories before local-only commits
 * may be replayed on the newer remote tip.
 */
export async function reconcileSharedBranch(args: {
  runGit: GitCommandRunner;
  remote: string;
  branch: string;
  historySourceBranch: string;
  baseSha: string;
  localSha: string;
  remoteRef?: string;
}): Promise<SharedBranchReconciliation> {
  const history = await ensureCompleteRepositoryHistory({
    runGit: args.runGit,
    remote: args.remote,
    sourceBranch: args.historySourceBranch,
  });
  if (!history.ok) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: `${SHALLOW_PROVENANCE_RULE} ${history.note}`,
    };
  }

  const remoteRef = args.remoteRef ?? "refs/remotes/jarvis-delivery/current";
  const fetched = await args.runGit([
    "fetch",
    "--no-tags",
    args.remote,
    `+refs/heads/${args.branch}:${remoteRef}`,
  ]);
  if (fetched.code !== 0) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: `shared branch ${args.branch} could not be refreshed: ${oneLine(fetched.out) || "git fetch failed"}`,
    };
  }

  const remoteShaResult = await args.runGit(["rev-parse", remoteRef]);
  const remoteSha = remoteShaResult.code === 0 ? remoteShaResult.out.trim() : "";
  if (!remoteSha) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: `shared branch ${args.branch} has no verifiable remote tip`,
    };
  }

  const baseInLocal = await gitCommitIsAncestor(args.runGit, args.baseSha, args.localSha);
  if (baseInLocal !== true) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: baseInLocal === null
        ? `local lineage from ${args.baseSha} could not be verified; the canonical shared branch must be resumed`
        : `local history no longer descends from canonical base ${args.baseSha}; the shared branch will not be rewritten`,
    };
  }

  const localInRemote = await gitCommitIsAncestor(args.runGit, args.localSha, remoteRef);
  if (localInRemote === true) {
    return {
      status: "already_delivered",
      localSha: args.localSha,
      rebased: false,
      note: `newer checkpoint branch ${args.branch} already contains this delivery`,
    };
  }

  const remoteInLocal = await gitCommitIsAncestor(args.runGit, remoteRef, args.localSha);
  if (remoteInLocal === true) {
    return {
      status: "ready",
      localSha: args.localSha,
      rebased: false,
      note: `local delivery fast-forwards shared branch ${args.branch}`,
    };
  }
  if (localInRemote === null || remoteInLocal === null) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: `lineage against shared branch ${args.branch} could not be verified`,
    };
  }

  const baseInRemote = await gitCommitIsAncestor(args.runGit, args.baseSha, remoteRef);
  if (baseInRemote !== true) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: baseInRemote === null
        ? `remote lineage from ${args.baseSha} could not be verified`
        : `shared branch ${args.branch} no longer descends from the recorded base; resume from its canonical tip`,
    };
  }

  const head = await args.runGit(["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.out.trim() !== args.localSha) {
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: "the checked-out tip changed before shared-branch reconciliation",
    };
  }

  const rebased = await args.runGit(["rebase", "--onto", remoteRef, args.baseSha]);
  if (rebased.code !== 0) {
    await args.runGit(["rebase", "--abort"]);
    return {
      status: "retry",
      localSha: args.localSha,
      rebased: false,
      note: `shared branch ${args.branch} changed concurrently; replay requires a clean checkpoint`,
    };
  }

  const newHead = await args.runGit(["rev-parse", "HEAD"]);
  const nextLocal = newHead.code === 0 ? newHead.out.trim() : "";
  const isFastForward = nextLocal
    ? await gitCommitIsAncestor(args.runGit, remoteRef, nextLocal)
    : null;
  if (isFastForward !== true) {
    return {
      status: "retry",
      localSha: nextLocal || args.localSha,
      rebased: true,
      note: `rebased delivery could not be proven to fast-forward shared branch ${args.branch}`,
    };
  }
  return {
    status: "ready",
    localSha: nextLocal,
    rebased: true,
    note: `local delivery rebased onto canonical shared branch ${args.branch}`,
  };
}
