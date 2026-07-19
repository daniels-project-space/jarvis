type FetchLike = typeof fetch;

export type PullRequestDelivery = {
  number: number;
  url: string;
  headSha: string;
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
}): Promise<MergeDeliveryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? wait;
  const headers = apiHeaders(args.token);
  const attempts = Math.max(1, Math.min(90, args.attempts ?? 60));
  let headSha = args.pull.headSha;
  let lastMessage = "GitHub checks have not completed yet";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (args.shouldContinue && !(await args.shouldContinue())) {
      return { status: "pending", note: "delivery lease ended before merge" };
    }
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
        return {
          status: "merged",
          sha: String(payload.sha ?? ""),
          note: String(payload.message ?? "Pull request merged"),
        };
      }
      lastMessage = String(payload.message ?? lastMessage);
    } else if (merged) {
      const payload = (await merged.json().catch(() => ({}))) as { message?: string };
      lastMessage = String(payload.message ?? `${merged.status} from GitHub merge`);
      if (![405, 409, 422].includes(merged.status)) {
        return { status: "blocked", note: lastMessage.slice(0, 500) };
      }
    }

    const stateResponse = await fetchImpl(
      `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}`,
      { headers, cache: "no-store" },
    ).catch(() => null);
    if (stateResponse?.ok) {
      const state = (await stateResponse.json()) as {
        state?: string;
        merged?: boolean;
        merge_commit_sha?: string;
        mergeable?: boolean | null;
        mergeable_state?: string;
        head?: { sha?: string };
      };
      if (state.merged) {
        return {
          status: "merged",
          sha: String(state.merge_commit_sha ?? ""),
          note: "Pull request was already merged",
        };
      }
      if (state.state === "closed") return { status: "blocked", note: "pull request closed before delivery" };
      headSha = String(state.head?.sha ?? headSha);
      if (state.mergeable === false && state.mergeable_state === "dirty") {
        return { status: "blocked", note: "the verified branch conflicts with the current default branch" };
      }
      if (state.mergeable_state === "behind") {
        await fetchImpl(
          `https://api.github.com/repos/${args.repo}/pulls/${args.pull.number}/update-branch`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify(headSha ? { expected_head_sha: headSha } : {}),
            cache: "no-store",
          },
        ).catch(() => null);
      }
    }
    if (attempt + 1 < attempts) await sleep(Math.max(0, args.intervalMs ?? 10_000));
  }
  return { status: "pending", note: lastMessage.slice(0, 500) };
}
