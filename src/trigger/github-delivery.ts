type FetchLike = typeof fetch;

export type PullRequestDelivery = {
  number: number;
  url: string;
  headSha: string;
};

export type MergeDeliveryResult =
  | { status: "merged"; sha: string; note: string; providerFinalized: boolean }
  | { status: "postmerge_pending"; sha: string; note: string }
  | { status: "blocked" | "pending"; note: string };

export type PullRequestChange = {
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  changedPaths: string[];
};

export type ProviderMergeGate =
  | { status: "not_required"; note: string }
  | {
      status: "ready";
      note: string;
      headSha: string;
      baseSha: string;
      controller: {
        confirmMerge: (change: PullRequestChange) => Promise<
          { status: "ready"; note: string } | { status: "blocked" | "pending"; note: string }
        >;
        proveLive: (mergeSha: string) => Promise<
          { status: "live"; note: string } | { status: "blocked" | "pending"; note: string }
        >;
        cleanup: () => Promise<void>;
      };
    }
  | { status: "blocked" | "pending"; note: string; refreshBase?: boolean };

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
): Promise<boolean> {
  if (!nodeId) return false;
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      query: "mutation ReadyForDelivery($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: nodeId },
    }),
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return false;
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
    errors?: unknown[];
  };
  return !payload.errors?.length
    && payload.data?.markPullRequestReadyForReview?.pullRequest?.isDraft === false;
}

export async function openDeliveryPullRequest(args: {
  repo: string;
  branch: string;
  title: string;
  body: string;
  token: string;
  draft?: boolean;
  fetchImpl?: FetchLike;
}): Promise<PullRequestDelivery | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = apiHeaders(args.token);
  try {
    const [owner] = args.repo.split("/");
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
        if (rows[0].draft === true && args.draft !== true) {
          const ready = await markReadyForReview(String(rows[0].node_id ?? ""), args.token, fetchImpl);
          if (!ready) return null;
        }
        return {
          number: rows[0].number,
          url: rows[0].html_url,
          headSha: String(rows[0].head?.sha ?? ""),
        };
      }
    }
    const metadata = await fetchImpl(`https://api.github.com/repos/${args.repo}`, {
      headers,
      cache: "no-store",
    });
    const repository = metadata.ok
      ? await metadata.json() as { default_branch?: string }
      : null;
    const base = String(repository?.default_branch ?? "main");
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
    });
    if (!created.ok) return null;
    const pull = (await created.json()) as {
      number?: number;
      html_url?: string;
      head?: { sha?: string };
    };
    if (!pull.number || !pull.html_url) return null;
    return {
      number: pull.number,
      url: pull.html_url,
      headSha: String(pull.head?.sha ?? ""),
    };
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizedRepo(repo: string): string {
  return repo.trim().replace(/\.git$/i, "").toLowerCase();
}

/**
 * Resolve every PR path and both immutable Git heads before a provider plan is
 * allowed to run. GitHub caps the endpoint at 3,000 files; reaching that cap is
 * unverifiable and therefore fails closed instead of silently missing a
 * provider-sensitive path.
 */
export async function inspectDeliveryPullRequest(args: {
  repo: string;
  pull: PullRequestDelivery;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<{ ok: true; change: PullRequestChange } | { ok: false; note: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = apiHeaders(args.token);
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}`,
      { headers, cache: "no-store" },
    );
    if (!response.ok) return { ok: false, note: `GitHub could not resolve pull request ${args.pull.number}` };
    const pull = (await response.json()) as {
      state?: string;
      merged?: boolean;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
      base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    };
    const headSha = String(pull.head?.sha ?? "");
    const baseSha = String(pull.base?.sha ?? "");
    const expectedRepo = normalizedRepo(args.repo);
    if (pull.state !== "open" || pull.merged || !/^[0-9a-f]{40,64}$/i.test(headSha) || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
      return { ok: false, note: "the open pull request heads could not be verified" };
    }
    if (args.pull.headSha && headSha !== args.pull.headSha) {
      return { ok: false, note: "the pull request head changed before provider release planning" };
    }
    if (
      normalizedRepo(String(pull.head?.repo?.full_name ?? "")) !== expectedRepo
      || normalizedRepo(String(pull.base?.repo?.full_name ?? "")) !== expectedRepo
    ) {
      return { ok: false, note: "the pull request crosses an unexpected repository boundary" };
    }

    const changedPaths = new Set<string>();
    for (let page = 1; page <= 30; page += 1) {
      const filesResponse = await fetchImpl(
        `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/files?per_page=100&page=${page}`,
        { headers, cache: "no-store" },
      );
      if (!filesResponse.ok) return { ok: false, note: "GitHub could not enumerate the verified pull request paths" };
      const files = (await filesResponse.json()) as Array<{ filename?: string; previous_filename?: string }>;
      for (const file of files) {
        if (file.filename) changedPaths.add(file.filename);
        if (file.previous_filename) changedPaths.add(file.previous_filename);
      }
      if (files.length < 100) {
        return {
          ok: true,
          change: {
            baseSha,
            headSha,
            baseBranch: String(pull.base?.ref ?? ""),
            headBranch: String(pull.head?.ref ?? ""),
            changedPaths: [...changedPaths].sort(),
          },
        };
      }
    }
    return { ok: false, note: "the pull request exceeds GitHub's exact 3,000-file verification boundary" };
  } catch (error) {
    return { ok: false, note: `pull request inspection failed: ${String(error).slice(0, 300)}` };
  }
}

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
  releaseGate: (change: PullRequestChange) => Promise<ProviderMergeGate>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MergeDeliveryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? wait;
  const headers = apiHeaders(args.token);
  const attempts = Math.max(1, Math.min(90, args.attempts ?? 60));
  let lastMessage = "GitHub checks have not completed yet";
  const inspection = await inspectDeliveryPullRequest({
    repo: args.repo,
    pull: args.pull,
    token: args.token,
    fetchImpl,
  });
  if (!inspection.ok) return { status: "blocked", note: inspection.note };
  const gate = await args.releaseGate(inspection.change);
  if (gate.status === "blocked") return gate;
  if (gate.status === "pending") {
    if (gate.refreshBase) {
      await fetchImpl(
        `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/update-branch`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ expected_head_sha: inspection.change.headSha }),
          cache: "no-store",
        },
      ).catch(() => null);
    }
    return { status: "pending", note: gate.note };
  }
  const providerLockedHead = gate.status === "ready" ? gate.headSha : "";
  const providerLockedBase = gate.status === "ready" ? gate.baseSha : "";
  if (providerLockedHead && providerLockedHead !== inspection.change.headSha) {
    if (gate.status === "ready") await gate.controller.cleanup();
    return { status: "blocked", note: "the provider release proof does not match the pull request head" };
  }
  if (providerLockedBase && providerLockedBase !== inspection.change.baseSha) {
    if (gate.status === "ready") await gate.controller.cleanup();
    return { status: "blocked", note: "the provider release proof does not match the pull request base" };
  }

  const completeMergedDelivery = async (shaInput: string, note: string): Promise<MergeDeliveryResult> => {
    const sha = shaInput.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      return { status: "postmerge_pending", sha, note: "GitHub merged the pull request but did not return an exact merge commit" };
    }
    if (gate.status !== "ready") {
      return { status: "merged", sha, note, providerFinalized: false };
    }
    const live = await gate.controller.proveLive(sha);
    if (live.status !== "live") return { status: "postmerge_pending", sha, note: live.note };
    return { status: "merged", sha, note: `${note}; ${live.note}`, providerFinalized: true };
  };

  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (args.shouldContinue && !(await args.shouldContinue())) {
        return { status: "pending", note: "delivery lease ended before merge" };
      }

      // GitHub's merge endpoint can pin only the head SHA. Resolve and compare
      // the base immediately before the controller's ownership recheck and PUT;
      // a changed base invalidates the provider candidate instead of silently
      // merging a bundle prepared against stale main.
      const stateResponse = await fetchImpl(
        `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}`,
        { headers, cache: "no-store" },
      ).catch(() => null);
      if (!stateResponse?.ok) {
        return { status: "pending", note: "GitHub could not recheck the pull request immediately before merge" };
      }
      const state = (await stateResponse.json()) as {
        state?: string;
        merged?: boolean;
        merge_commit_sha?: string;
        mergeable?: boolean | null;
        mergeable_state?: string;
        head?: { sha?: string };
        base?: { sha?: string };
      };
      if (state.merged) {
        return await completeMergedDelivery(String(state.merge_commit_sha ?? ""), "Pull request was already merged");
      }
      if (state.state === "closed") return { status: "blocked", note: "pull request closed before delivery" };
      const observedHead = String(state.head?.sha ?? "");
      const observedBase = String(state.base?.sha ?? "");
      if (!/^[0-9a-f]{40,64}$/i.test(observedHead) || !/^[0-9a-f]{40,64}$/i.test(observedBase)) {
        return { status: "pending", note: "GitHub did not return exact pull request heads immediately before merge" };
      }
      if (providerLockedHead && observedHead !== providerLockedHead) {
        return { status: "pending", note: "the pull request head changed after provider verification; prerequisites must be re-attested" };
      }
      if (providerLockedBase && observedBase !== providerLockedBase) {
        return { status: "pending", note: "main advanced after provider verification; the exact candidate must be refreshed and re-attested" };
      }
      if (state.mergeable === false && state.mergeable_state === "dirty") {
        return { status: "blocked", note: "the verified branch conflicts with the current default branch" };
      }
      if (state.mergeable_state === "behind") {
        await fetchImpl(
          `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/update-branch`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ expected_head_sha: observedHead }),
            cache: "no-store",
          },
        ).catch(() => null);
        return {
          status: "pending",
          note: providerLockedHead
            ? "GitHub refreshed the branch; provider prerequisites must be re-attested for its new exact head and base"
            : "GitHub refreshed the branch; delivery will resume on its new exact head",
        };
      }

      if (gate.status === "ready") {
        const confirmed = await gate.controller.confirmMerge({
          ...inspection.change,
          headSha: observedHead,
          baseSha: observedBase,
        });
        if (confirmed.status !== "ready") return confirmed;
      }

      const merged = await fetchImpl(
        `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/merge`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            sha: observedHead,
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
          return await completeMergedDelivery(
            String(payload.sha ?? ""),
            String(payload.message ?? "Pull request merged"),
          );
        }
        lastMessage = String(payload.message ?? lastMessage);
      } else if (merged) {
        const payload = (await merged.json().catch(() => ({}))) as { message?: string };
        lastMessage = String(payload.message ?? `${merged.status} from GitHub merge`);
        if (![405, 409, 422].includes(merged.status)) {
          return { status: "blocked", note: lastMessage.slice(0, 500) };
        }
      }
      if (attempt + 1 < attempts) await sleep(Math.max(0, args.intervalMs ?? 10_000));
    }
    return { status: "pending", note: lastMessage.slice(0, 500) };
  } finally {
    if (gate.status === "ready") await gate.controller.cleanup();
  }
}
