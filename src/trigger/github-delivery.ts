import { GITHUB_REST_API_VERSION } from "./github-integration-adapter";

type FetchLike = typeof fetch;

export type DeliveryEffect = Readonly<{
  effectId: string;
  kind: "create_draft_pr" | "create_pr" | "promote_pr" | "merge_pr";
  headSha: string;
  baseSha: string;
  pullRequestNumber?: number;
}>;

export type DeliveryEffectPreparation = Readonly<{
  replay: boolean;
  observation?: "applied" | "not_applied" | "unknown" | null;
}>;

export type PullRequestDelivery = {
  number: number;
  url: string;
  nodeId: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha?: string;
};

export type EffectHooks = {
  prepareEffect?: (
    effect: DeliveryEffect,
    options?: { reconcileOnly?: boolean },
  ) => Promise<DeliveryEffectPreparation | boolean | null>;
  observeEffect?: (
    effect: DeliveryEffect,
    observation: "applied" | "not_applied" | "unknown",
    detail?: PullRequestDelivery,
  ) => Promise<void>;
};

export type ReviewedDeliveryHead = {
  headSha: string;
  baseSha: string;
};

export type MergeDeliveryResult =
  | { status: "merged"; sha: string; note: string; pull: PullRequestDelivery }
  | { status: "blocked" | "pending"; note: string };

export type ControllerDeliveryResult =
  | {
      ok: true;
      outcome: "protected_draft" | "read_only_complete" | "no_change" | "merged";
      deliveryStatus: "branch" | "pull_request" | "merged";
      providerCall: boolean;
      pull?: PullRequestDelivery;
      mergeCommitSha?: string;
    }
  | { ok: false; note: string };

export function validatedGoalDeliveryBranch(job: { goalStage?: unknown; branch?: unknown }): string {
  if (job.goalStage !== "validating" || typeof job.branch !== "string") return "";
  return /^jarvis\/[a-z0-9._/-]+$/i.test(job.branch) ? job.branch : "";
}

const apiHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "x-github-api-version": GITHUB_REST_API_VERSION,
});

type PullPayload = {
  number?: number;
  html_url?: string;
  node_id?: string;
  draft?: boolean;
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { sha?: string };
  base?: { sha?: string };
};

function pullIdentity(payload: PullPayload): PullRequestDelivery | null {
  if (!payload.number || !payload.html_url || !payload.node_id || typeof payload.draft !== "boolean"
    || !payload.head?.sha || !payload.base?.sha) return null;
  return {
    number: payload.number,
    url: payload.html_url,
    nodeId: payload.node_id,
    draft: payload.draft,
    headSha: payload.head.sha,
    baseSha: payload.base.sha,
    ...(payload.merge_commit_sha ? { mergeCommitSha: payload.merge_commit_sha } : {}),
  };
}

function exactPull(pull: PullRequestDelivery | null, reviewed: ReviewedDeliveryHead) {
  return Boolean(pull && pull.headSha === reviewed.headSha && pull.baseSha === reviewed.baseSha);
}

function samePull(left: PullRequestDelivery | null | undefined, right: PullRequestDelivery | null | undefined) {
  return Boolean(left && right && left.number === right.number && left.url === right.url
    && left.nodeId === right.nodeId && left.draft === right.draft
    && left.headSha === right.headSha && left.baseSha === right.baseSha);
}

async function prepare(
  hooks: EffectHooks,
  effect: DeliveryEffect,
  options?: { reconcileOnly?: boolean },
): Promise<DeliveryEffectPreparation | null> {
  if (!hooks.prepareEffect || !hooks.observeEffect) return null;
  const prepared = await hooks.prepareEffect(effect, options);
  if (!prepared) return null;
  return typeof prepared === "boolean" ? { replay: false } : prepared;
}

async function observe(
  hooks: EffectHooks,
  effect: DeliveryEffect,
  observation: "applied" | "not_applied" | "unknown",
  detail?: PullRequestDelivery,
) {
  if (!hooks.observeEffect) throw new Error("delivery observation authority is unavailable");
  await hooks.observeEffect(effect, observation, detail);
}

async function readReviewedRefs(args: {
  repo: string; branch: string; token: string; reviewed: ReviewedDeliveryHead; fetchImpl: FetchLike;
}): Promise<{ baseBranch: string } | null> {
  const headers = apiHeaders(args.token);
  const [sourceResponse, repositoryResponse] = await Promise.all([
    args.fetchImpl(`https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(args.branch)}`, { headers, cache: "no-store" }),
    args.fetchImpl(`https://api.github.com/repos/${args.repo}`, { headers, cache: "no-store" }),
  ]);
  if (!sourceResponse.ok || !repositoryResponse.ok) return null;
  const source = await sourceResponse.json() as { object?: { sha?: string } };
  const repository = await repositoryResponse.json() as { default_branch?: string };
  const baseBranch = String(repository.default_branch ?? "main");
  const baseResponse = await args.fetchImpl(
    `https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers, cache: "no-store" },
  );
  const base = baseResponse.ok ? await baseResponse.json() as { object?: { sha?: string } } : null;
  return String(source.object?.sha ?? "") === args.reviewed.headSha
    && String(base?.object?.sha ?? "") === args.reviewed.baseSha
    ? { baseBranch }
    : null;
}

async function readPull(repo: string, number: number, token: string, fetchImpl: FetchLike) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: apiHeaders(token), cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return { payload: null, pull: null };
  const payload = await response.json() as PullPayload;
  return { payload, pull: pullIdentity(payload) };
}

async function recoverPreparedReadyPull(
  pull: PullRequestDelivery,
  reviewed: ReviewedDeliveryHead,
  branch: string,
  hooks: EffectHooks,
) {
  const candidates: DeliveryEffect[] = [
    {
      effectId: `promote:${pull.number}:${reviewed.headSha}:${reviewed.baseSha}`,
      kind: "promote_pr", headSha: reviewed.headSha, baseSha: reviewed.baseSha,
      pullRequestNumber: pull.number,
    },
    {
      effectId: `pr:ready:${branch}:${reviewed.headSha}:${reviewed.baseSha}`,
      kind: "create_pr", headSha: reviewed.headSha, baseSha: reviewed.baseSha,
    },
  ];
  for (const effect of candidates) {
    const prior = await prepare(hooks, effect, { reconcileOnly: true });
    if (!prior?.replay) continue;
    await observe(hooks, effect, "applied", pull);
    return true;
  }
  return false;
}

async function markReadyForReview(args: {
  repo: string; branch: string; token: string; reviewed: ReviewedDeliveryHead;
  pull: PullRequestDelivery; fetchImpl: FetchLike;
} & EffectHooks): Promise<PullRequestDelivery | null> {
  const refs = await readReviewedRefs(args);
  if (!refs) return null;
  const immediatelyBefore = await readPull(args.repo, args.pull.number, args.token, args.fetchImpl);
  if (!exactPull(immediatelyBefore.pull, args.reviewed) || !samePull(immediatelyBefore.pull, args.pull)
    || immediatelyBefore.pull?.draft !== true) return null;
  const effect: DeliveryEffect = {
    effectId: `promote:${args.pull.number}:${args.reviewed.headSha}:${args.reviewed.baseSha}`,
    kind: "promote_pr", headSha: args.reviewed.headSha, baseSha: args.reviewed.baseSha,
    pullRequestNumber: args.pull.number,
  };
  if (!await prepare(args, effect)) return null;
  const response = await args.fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: apiHeaders(args.token),
    body: JSON.stringify({
      query: "mutation ReadyForDelivery($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: args.pull.nodeId },
    }),
    cache: "no-store",
  }).catch(() => null);
  const observed = await readPull(args.repo, args.pull.number, args.token, args.fetchImpl);
  if (exactPull(observed.pull, args.reviewed) && observed.pull?.draft === false
    && observed.pull.number === args.pull.number) {
    await observe(args, effect, "applied", observed.pull);
    return observed.pull;
  }
  await observe(args, effect, response ? "not_applied" : "unknown");
  return null;
}

export async function openDeliveryPullRequest(args: {
  repo: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  draft?: boolean;
  reviewed: ReviewedDeliveryHead;
  expectedPull?: PullRequestDelivery;
  fetchImpl?: FetchLike;
} & EffectHooks): Promise<PullRequestDelivery | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = apiHeaders(args.token);
  const [owner] = args.repo.split("/");
  // Discovery is read-only and precedes write authorization so a previously
  // prepared CREATE/PROMOTE can be reconciled even after the base ref moves.
  // A genuinely new provider write still gets fresh exact ref checks below.
  const listed = await fetchImpl(
    `https://api.github.com/repos/${args.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.branch}`)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  const rows = listed?.ok ? await listed.json() as PullPayload[] : [];
  if (rows.length > 1) return null;
  const existing = rows[0] ? pullIdentity(rows[0]) : null;
  if (rows[0] && (!exactPull(existing, args.reviewed) || !existing)) return null;
  if (existing) {
    if (args.draft === true) {
      if (!existing.draft) return null;
      const effect: DeliveryEffect = {
        effectId: `pr:draft:${args.branch}:${args.reviewed.headSha}:${args.reviewed.baseSha}`,
        kind: "create_draft_pr", headSha: args.reviewed.headSha, baseSha: args.reviewed.baseSha,
      };
      if (!await prepare(args, effect)) return null;
      await observe(args, effect, "applied", existing);
      return existing;
    }
    if (existing.draft) return await markReadyForReview({ ...args, pull: existing, fetchImpl });
    if (samePull(existing, args.expectedPull)) return existing;
    return await recoverPreparedReadyPull(existing, args.reviewed, args.branch, args) ? existing : null;
  }

  // This is the write-authority read: exact source and default-base state is
  // observed again immediately before the lease-renewing preparation.
  const refs = await readReviewedRefs({ ...args, fetchImpl });
  if (!refs) return null;
  const effect: DeliveryEffect = {
    effectId: `pr:${args.draft === true ? "draft" : "ready"}:${args.branch}:${args.reviewed.headSha}:${args.reviewed.baseSha}`,
    kind: args.draft === true ? "create_draft_pr" : "create_pr",
    headSha: args.reviewed.headSha, baseSha: args.reviewed.baseSha,
  };
  if (!await prepare(args, effect)) return null;
  const created = await fetchImpl(`https://api.github.com/repos/${args.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: args.title.slice(0, 120), head: args.branch, base: refs.baseBranch,
      body: args.body.slice(0, 8_000), draft: args.draft === true,
    }),
    cache: "no-store",
  }).catch(() => null);
  if (created?.ok) {
    const result = pullIdentity(await created.json() as PullPayload);
    if (exactPull(result, args.reviewed) && result?.draft === (args.draft === true)) {
      await observe(args, effect, "applied", result);
      return result;
    }
    await observe(args, effect, "unknown");
    return null;
  }
  await observe(args, effect, created ? "not_applied" : "unknown");
  if (created) return null;
  const reconciled = await fetchImpl(
    `https://api.github.com/repos/${args.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.branch}`)}`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  const recoveredRows = reconciled?.ok ? await reconciled.json() as PullPayload[] : [];
  const recovered = recoveredRows.length === 1 ? pullIdentity(recoveredRows[0]) : null;
  if (!exactPull(recovered, args.reviewed) || recovered?.draft !== (args.draft === true)) return null;
  await observe(args, effect, "applied", recovered);
  return recovered;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function mergeVerifiedPullRequest(args: {
  repo: string;
  pull: PullRequestDelivery;
  title: string;
  token: string;
  attempts?: number;
  intervalMs?: number;
  shouldContinue?: () => Promise<boolean>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  reviewedHeadSha: string;
  reviewedBaseSha: string;
} & EffectHooks): Promise<MergeDeliveryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? wait;
  const headers = apiHeaders(args.token);
  const attempts = Math.max(1, Math.min(90, args.attempts ?? 60));
  const reviewed = { headSha: args.reviewedHeadSha, baseSha: args.reviewedBaseSha };
  if (!exactPull(args.pull, reviewed) || args.pull.draft) {
    return { status: "blocked", note: "pull request identity is not the exact ready reviewed receipt" };
  }
  let lastMessage = "GitHub checks have not completed yet";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (args.shouldContinue && !(await args.shouldContinue())) {
      return { status: "pending", note: "delivery lease ended before merge" };
    }
    const state = await readPull(args.repo, args.pull.number, args.token, fetchImpl);
    if (!state.payload || !exactPull(state.pull, reviewed) || !samePull(state.pull, args.pull)) {
      return { status: "blocked", note: "pull request identity changed after controller review; a fresh review is required" };
    }
    const effect: DeliveryEffect = {
      effectId: `merge:${args.pull.number}:${reviewed.headSha}:${reviewed.baseSha}`,
      kind: "merge_pr", headSha: reviewed.headSha, baseSha: reviewed.baseSha,
      pullRequestNumber: args.pull.number,
    };
    if (state.payload.merged) {
      const prior = await prepare(args, effect, { reconcileOnly: true });
      if (!prior?.replay || !state.pull?.mergeCommitSha) {
        return { status: "blocked", note: "completed pull request has no matching prepared merge effect" };
      }
      await observe(args, effect, "applied", state.pull);
      return { status: "merged", sha: state.pull.mergeCommitSha, note: "Pull request merge reconciled", pull: state.pull };
    }
    if (state.payload.state === "closed") return { status: "blocked", note: "pull request closed before delivery" };
    if (state.payload.mergeable === false && state.payload.mergeable_state === "dirty") {
      return { status: "blocked", note: "the verified branch conflicts with the current default branch" };
    }
    if (state.payload.mergeable_state === "behind") {
      return { status: "blocked", note: "default branch advanced after controller review; a fresh review is required" };
    }
    if (args.shouldContinue && !(await args.shouldContinue())) {
      return { status: "pending", note: "delivery lease ended before merge" };
    }
    if (!await prepare(args, effect)) return { status: "pending", note: "delivery effect was not durably prepared" };
    const merged = await fetchImpl(`https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/merge`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        sha: reviewed.headSha, merge_method: "squash", commit_title: args.title.slice(0, 120),
        commit_message: "Verified and delivered automatically by JARVIS.",
      }),
      cache: "no-store",
    }).catch(() => null);
    const observed = await readPull(args.repo, args.pull.number, args.token, fetchImpl);
    if (!observed.payload || !exactPull(observed.pull, reviewed) || !samePull(observed.pull, args.pull)) {
      await observe(args, effect, "unknown");
      return { status: "blocked", note: "pull request identity changed after merge response; a fresh review is required" };
    }
    if (observed.payload.merged && observed.pull?.mergeCommitSha) {
      await observe(args, effect, "applied", observed.pull);
      return {
        status: "merged", sha: observed.pull.mergeCommitSha,
        note: merged?.ok ? "Pull request merged" : "Pull request merge reconciled",
        pull: observed.pull,
      };
    }
    if (merged) {
      const payload = await merged.json().catch(() => ({})) as { message?: string };
      lastMessage = String(payload.message ?? `${merged.status} from GitHub merge`);
      await observe(args, effect, "not_applied");
      if (![405, 409, 422].includes(merged.status)) return { status: "blocked", note: lastMessage.slice(0, 500) };
    } else await observe(args, effect, "unknown");
    if (attempt + 1 < attempts) await sleep(Math.max(0, args.intervalMs ?? 10_000));
  }
  return { status: "pending", note: lastMessage.slice(0, 500) };
}

/** The one executable provider-delivery path used by Trigger continuations. */
export async function continueRepositoryDelivery(args: {
  policy: "manual" | "read_only" | "auto_merge";
  branchChanged: boolean;
  reconcileMerge?: boolean;
  repo: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  reviewed: ReviewedDeliveryHead;
  expectedPull?: PullRequestDelivery;
  shouldContinue?: () => Promise<boolean>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
} & EffectHooks): Promise<ControllerDeliveryResult> {
  if (args.policy === "read_only") {
    return { ok: true, outcome: "read_only_complete", deliveryStatus: "branch", providerCall: false };
  }
  if (!args.branchChanged && !args.reconcileMerge) {
    return { ok: true, outcome: "no_change", deliveryStatus: "branch", providerCall: false };
  }
  if (args.reconcileMerge) {
    // A prepared merge is reconciled only through the complete immutable PR
    // identity already held by the delivery attempt. Do not rediscover open
    // PRs or authorize a new write from the now-advanced default branch.
    const expected = args.expectedPull;
    if (args.policy !== "auto_merge" || !expected
      || !Number.isSafeInteger(expected.number) || expected.number <= 0
      || !expected.url || !expected.nodeId || expected.draft
      || !exactPull(expected, args.reviewed)) {
      return { ok: false, note: "prepared merge is missing the exact reviewed pull request identity" };
    }
    const reconciled = await mergeVerifiedPullRequest({
      ...args, pull: expected,
      reviewedHeadSha: args.reviewed.headSha, reviewedBaseSha: args.reviewed.baseSha,
    });
    if (reconciled.status !== "merged") return { ok: false, note: reconciled.note };
    return {
      ok: true, outcome: "merged", deliveryStatus: "merged", providerCall: false,
      pull: reconciled.pull, mergeCommitSha: reconciled.sha,
    };
  }
  const pull = await openDeliveryPullRequest({
    ...args, draft: args.policy === "manual",
  });
  if (!pull) return { ok: false, note: "the controller could not open or recover the exact verified pull request" };
  if (args.policy === "manual") {
    return { ok: true, outcome: "protected_draft", deliveryStatus: "pull_request", providerCall: true, pull };
  }
  const merge = await mergeVerifiedPullRequest({
    ...args, pull, reviewedHeadSha: args.reviewed.headSha, reviewedBaseSha: args.reviewed.baseSha,
  });
  if (merge.status !== "merged") return { ok: false, note: merge.note };
  return {
    ok: true, outcome: "merged", deliveryStatus: "merged", providerCall: true,
    pull: merge.pull, mergeCommitSha: merge.sha,
  };
}
