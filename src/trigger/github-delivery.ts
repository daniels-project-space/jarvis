type FetchLike = typeof fetch;

export type DeliveryEffect = Readonly<{
  effectId: string;
  kind: "create_draft_pr" | "create_pr" | "promote_pr" | "merge_pr";
  headSha: string;
  baseSha: string;
  pullRequestNumber?: number;
}>;

type EffectHooks = {
  prepareEffect?: (effect: DeliveryEffect) => Promise<boolean>;
  observeEffect?: (effect: DeliveryEffect, observation: "applied" | "not_applied" | "unknown", detail?: PullRequestDelivery) => Promise<void>;
};

export type PullRequestDelivery = {
  number: number;
  url: string;
  headSha: string;
};

export type ReviewedDeliveryHead = {
  /** The exact source commit authenticated by the controller receipt. */
  headSha: string;
  /** The default-branch commit used when that receipt was reviewed. */
  baseSha: string;
};

export type MergeDeliveryResult =
  | { status: "merged"; sha: string; note: string }
  | { status: "blocked" | "pending"; note: string };

export function validatedGoalDeliveryBranch(job: {
  goalStage?: unknown;
  branch?: unknown;
}): string {
  if (job.goalStage !== "validating" || typeof job.branch !== "string") return "";
  return /^jarvis\/[a-z0-9._/-]+$/i.test(job.branch) ? job.branch : "";
}

const apiHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
});

async function markReadyForReview(
  nodeId: string,
  token: string,
  fetchImpl: FetchLike,
  effect: DeliveryEffect,
  hooks: EffectHooks,
): Promise<boolean> {
  if (!nodeId) return false;
  if (!hooks.prepareEffect || !hooks.observeEffect || !await hooks.prepareEffect(effect)) return false;
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      query: "mutation ReadyForDelivery($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: nodeId },
    }),
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) {
    await hooks.observeEffect?.(effect, response ? "not_applied" : "unknown");
    return false;
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
    errors?: unknown[];
  };
  const applied = !payload.errors?.length
    && payload.data?.markPullRequestReadyForReview?.pullRequest?.isDraft === false;
  await hooks.observeEffect?.(effect, applied ? "applied" : "not_applied");
  return applied;
}

export async function openDeliveryPullRequest(args: {
  repo: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  draft?: boolean;
  reviewed?: ReviewedDeliveryHead;
  fetchImpl?: FetchLike;
} & EffectHooks): Promise<PullRequestDelivery | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = apiHeaders(args.token);
  try {
    const [owner] = args.repo.split("/");
    // The receipt is an authority, not a best-effort annotation.  Refuse to
    // create/reuse a PR when either side of the reviewed relationship moved.
    // In particular, never let GitHub's update-branch operation manufacture a
    // new head that the controller did not review and sign.
    if (args.reviewed) {
      const [sourceRef, repository] = await Promise.all([
        fetchImpl(`https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(args.branch)}`, { headers, cache: "no-store" }),
        fetchImpl(`https://api.github.com/repos/${args.repo}`, { headers, cache: "no-store" }),
      ]);
      if (!sourceRef.ok || !repository.ok) return null;
      const source = await sourceRef.json() as { object?: { sha?: string } };
      const metadata = await repository.json() as { default_branch?: string };
      const defaultBranch = String(metadata.default_branch ?? "main");
      const baseRef = await fetchImpl(
        `https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
        { headers, cache: "no-store" },
      );
      const base = baseRef.ok ? await baseRef.json() as { object?: { sha?: string } } : null;
      if (String(source.object?.sha ?? "") !== args.reviewed.headSha
        || String(base?.object?.sha ?? "") !== args.reviewed.baseSha) return null;
    }
    const existing = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.branch}`)}`,
      { headers, cache: "no-store" },
    );
    if (existing.ok) {
      const rows = (await existing.json()) as Array<{
        number?: number;
        html_url?: string;
        node_id?: string;
        draft?: boolean;
        head?: { sha?: string };
      }>;
      if (rows[0]?.number && rows[0]?.html_url) {
        if (args.reviewed && String(rows[0].head?.sha ?? "") !== args.reviewed.headSha) return null;
        // Manual delivery recognizes only the exact protected draft. It can
        // neither adopt a ready PR nor promote one.
        if (args.draft === true && rows[0].draft !== true) return null;
        if (rows[0].draft === true && args.draft !== true) {
          if (!args.reviewed) return null;
          const effect: DeliveryEffect = {
            effectId: `promote:${rows[0].number}:${args.reviewed.headSha}:${args.reviewed.baseSha}`,
            kind: "promote_pr", headSha: args.reviewed.headSha, baseSha: args.reviewed.baseSha,
            pullRequestNumber: rows[0].number,
          };
          const ready = await markReadyForReview(String(rows[0].node_id ?? ""), args.token, fetchImpl, effect, args);
          if (!ready) return null;
        }
        return {
          number: rows[0].number,
          url: rows[0].html_url,
          headSha: String(rows[0].head?.sha ?? ""),
        };
      }
    }
    if (!args.reviewed) return null;
    // Repeat the exact source/base authority observation immediately before
    // preparing the write. Earlier discovery calls are not write authority.
    const [sourceCheck, repoCheck] = await Promise.all([
      fetchImpl(`https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(args.branch)}`, { headers, cache: "no-store" }),
      fetchImpl(`https://api.github.com/repos/${args.repo}`, { headers, cache: "no-store" }),
    ]);
    if (!sourceCheck.ok || !repoCheck.ok) return null;
    const sourceState = await sourceCheck.json() as { object?: { sha?: string } };
    const repoState = await repoCheck.json() as { default_branch?: string };
    const base = String(repoState.default_branch ?? "main");
    const baseCheck = await fetchImpl(`https://api.github.com/repos/${args.repo}/git/ref/heads/${encodeURIComponent(base)}`, { headers, cache: "no-store" });
    const baseState = baseCheck.ok ? await baseCheck.json() as { object?: { sha?: string } } : null;
    if (String(sourceState.object?.sha ?? "") !== args.reviewed.headSha || String(baseState?.object?.sha ?? "") !== args.reviewed.baseSha) return null;
    const effect: DeliveryEffect = {
      effectId: `pr:${args.draft === true ? "draft" : "ready"}:${args.branch}:${args.reviewed.headSha}:${args.reviewed.baseSha}`,
      kind: args.draft === true ? "create_draft_pr" : "create_pr",
      headSha: args.reviewed.headSha, baseSha: args.reviewed.baseSha,
    };
    if (!args.prepareEffect || !args.observeEffect || !await args.prepareEffect(effect)) return null;
    const created = await fetchImpl(`https://api.github.com/repos/${args.repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: args.title.slice(0, 120),
        head: args.branch,
        base,
        body: args.body.slice(0, 8_000),
        draft: args.draft === true,
      }),
      cache: "no-store",
    }).catch(() => null);
    if (!created) {
      await args.observeEffect?.(effect, "unknown");
      const reconciled = await fetchImpl(
        `https://api.github.com/repos/${args.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.branch}`)}`,
        { headers, cache: "no-store" },
      ).catch(() => null);
      const rows = reconciled?.ok ? await reconciled.json() as Array<{
        number?: number; html_url?: string; draft?: boolean; head?: { sha?: string };
      }> : [];
      const exact = rows.find((row) => row.number && row.html_url
        && String(row.head?.sha ?? "") === args.reviewed!.headSha
        && (args.draft !== true || row.draft === true));
      if (!exact?.number || !exact.html_url) return null;
      const result = { number: exact.number, url: exact.html_url, headSha: String(exact.head?.sha ?? "") };
      await args.observeEffect?.(effect, "applied", result);
      return result;
    }
    if (!created.ok) {
      await args.observeEffect?.(effect, "not_applied");
      return null;
    }
    const pull = (await created.json()) as {
      number?: number;
      html_url?: string;
      head?: { sha?: string };
    };
    if (!pull.number || !pull.html_url || String(pull.head?.sha ?? "") !== args.reviewed.headSha) {
      await args.observeEffect?.(effect, "unknown");
      return null;
    }
    const result = {
      number: pull.number,
      url: pull.html_url,
      headSha: String(pull.head?.sha ?? ""),
    };
    await args.observeEffect?.(effect, "applied", result);
    return result;
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Let GitHub's branch protection remain the final delivery gate. The
 * controller retries while checks are pending, pins the expected head SHA,
 * and never bypasses a required check or review.
 */
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
  /** Required for receipt-bound delivery; prevents head substitution. */
  reviewedHeadSha?: string;
  /** The reviewed default-branch commit; checked before every PUT. */
  reviewedBaseSha?: string;
} & EffectHooks): Promise<MergeDeliveryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? wait;
  const headers = apiHeaders(args.token);
  const attempts = Math.max(1, Math.min(90, args.attempts ?? 60));
  const reviewedHeadSha = args.reviewedHeadSha ?? args.pull.headSha;
  if (!reviewedHeadSha || args.pull.headSha !== reviewedHeadSha) {
    return { status: "blocked", note: "pull request head is not the reviewed receipt head" };
  }
  let headSha = reviewedHeadSha;
  let lastMessage = "GitHub checks have not completed yet";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (args.shouldContinue && !(await args.shouldContinue())) {
      return { status: "pending", note: "delivery lease ended before merge" };
    }
    // Preflight is intentionally before the consequential PUT, not a
    // diagnosis after it. A response-loss replay first proves that the same
    // PR/head was merged; it never sends a second merge request blindly.
    const stateResponse = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}`,
      { headers, cache: "no-store" },
    ).catch(() => null);
    if (!stateResponse?.ok) return { status: "blocked", note: "could not preflight the reviewed pull request" };
    const state = (await stateResponse.json()) as {
      state?: string; merged?: boolean; merge_commit_sha?: string;
      mergeable?: boolean | null; mergeable_state?: string;
      head?: { sha?: string }; base?: { sha?: string };
    };
    if (String(state.head?.sha ?? "") !== reviewedHeadSha) {
      return { status: "blocked", note: "pull request head changed after controller review; a fresh review is required" };
    }
    if (args.reviewedBaseSha && String(state.base?.sha ?? "") !== args.reviewedBaseSha) {
      return { status: "blocked", note: "default branch advanced after controller review; a fresh review is required" };
    }
    if (state.merged) return { status: "merged", sha: String(state.merge_commit_sha ?? ""), note: "Pull request was already merged" };
    if (state.state === "closed") return { status: "blocked", note: "pull request closed before delivery" };
    if (state.mergeable === false && state.mergeable_state === "dirty") return { status: "blocked", note: "the verified branch conflicts with the current default branch" };
    if (state.mergeable_state === "behind") return { status: "blocked", note: "default branch advanced after controller review; a fresh review is required" };
    if (args.shouldContinue && !(await args.shouldContinue())) return { status: "pending", note: "delivery lease ended before merge" };
    const effect: DeliveryEffect = {
      effectId: `merge:${args.pull.number}:${reviewedHeadSha}:${args.reviewedBaseSha ?? String(state.base?.sha ?? "")}`,
      kind: "merge_pr", headSha: reviewedHeadSha,
      baseSha: args.reviewedBaseSha ?? String(state.base?.sha ?? ""), pullRequestNumber: args.pull.number,
    };
    if (!args.prepareEffect || !args.observeEffect || !await args.prepareEffect(effect)) return { status: "pending", note: "delivery effect was not durably prepared" };
    const merged = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/merge`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...(headSha ? { sha: headSha } : {}),
          merge_method: "squash",
          commit_title: args.title.slice(0, 120),
          commit_message: "Verified and delivered automatically by JARVIS.",
        }),
        cache: "no-store",
      },
    ).catch(() => null);
    if (merged?.ok) {
      const payload = (await merged.json().catch(() => ({}))) as {
        merged?: boolean;
        sha?: string;
        message?: string;
      };
      if (payload.merged) {
        await args.observeEffect?.(effect, "applied");
        return {
          status: "merged",
          sha: String(payload.sha ?? ""),
          note: String(payload.message ?? "Pull request merged"),
        };
      }
      lastMessage = String(payload.message ?? lastMessage);
      await args.observeEffect?.(effect, "not_applied");
    } else if (merged) {
      const payload = (await merged.json().catch(() => ({}))) as { message?: string };
      lastMessage = String(payload.message ?? `${merged.status} from GitHub merge`);
      await args.observeEffect?.(effect, "not_applied");
      if (![405, 409, 422].includes(merged.status)) {
        return { status: "blocked", note: lastMessage.slice(0, 500) };
      }
    } else await args.observeEffect?.(effect, "unknown");

    const observedResponse = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}`,
      { headers, cache: "no-store" },
    ).catch(() => null);
    if (observedResponse?.ok) {
      const observed = (await observedResponse.json()) as {
        state?: string;
        merged?: boolean;
        merge_commit_sha?: string;
        mergeable?: boolean | null;
        mergeable_state?: string;
        head?: { sha?: string };
        base?: { sha?: string };
      };
      if (String(observed.head?.sha ?? "") !== reviewedHeadSha) {
        return { status: "blocked", note: "pull request head changed after controller review; a fresh review is required" };
      }
      if (args.reviewedBaseSha && String(observed.base?.sha ?? "") !== args.reviewedBaseSha) {
        return { status: "blocked", note: "default branch advanced after controller review; a fresh review is required" };
      }
      if (observed.merged) {
        return {
          status: "merged",
          sha: String(observed.merge_commit_sha ?? ""),
          note: "Pull request was already merged",
        };
      }
      if (observed.state === "closed") return { status: "blocked", note: "pull request closed before delivery" };
      if (observed.mergeable === false && observed.mergeable_state === "dirty") {
        return { status: "blocked", note: "the verified branch conflicts with the current default branch" };
      }
      if (observed.mergeable_state === "behind") {
        return { status: "blocked", note: "default branch advanced after controller review; a fresh review is required" };
      }
    }
    if (attempt + 1 < attempts) await sleep(Math.max(0, args.intervalMs ?? 10_000));
  }
  return { status: "pending", note: lastMessage.slice(0, 500) };
}
