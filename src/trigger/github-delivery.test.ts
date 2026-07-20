import { describe, expect, it, vi } from "vitest";
import {
  mergeVerifiedPullRequest,
  openDeliveryPullRequest,
  validatedGoalDeliveryBranch,
} from "./github-delivery";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const baseSha = "def456def456def456def456def456def456defa";
const inspectedPull = (
  headSha = "abc123abc123abc123abc123abc123abc123abcd",
  observedBaseSha = baseSha,
) => ({
  state: "open",
  merged: false,
  head: {
    sha: headSha,
    ref: "jarvis/paul-fix",
    repo: { full_name: "daniels-project-space/jarvis" },
  },
  base: {
    sha: observedBaseSha,
    ref: "main",
    repo: { full_name: "daniels-project-space/jarvis" },
  },
});

describe("autonomous GitHub delivery", () => {
  it("retains a validator's shared branch even though the model lease is read-only", () => {
    expect(validatedGoalDeliveryBranch({
      goalStage: "validating",
      branch: "jarvis/goal-123",
    })).toBe("jarvis/goal-123");
    expect(validatedGoalDeliveryBranch({ goalStage: "building", branch: "jarvis/goal-123" })).toBe("");
    expect(validatedGoalDeliveryBranch({ goalStage: "validating", branch: "main" })).toBe("");
  });

  it("opens a ready pull request and pins its head SHA", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { default_branch: "main" }))
      .mockResolvedValueOnce(response(201, {
        number: 42,
        html_url: "https://github.com/daniels-project-space/jarvis/pull/42",
        head: { sha: "abc123" },
      }));

    const pull = await openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis",
      branch: "jarvis/paul-fix",
      title: "Paul: fix",
      body: "Verified evidence",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(pull).toMatchObject({ number: 42, headSha: "abc123" });
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toMatchObject({ draft: false });
  });

  it("promotes a legacy draft before autonomous delivery", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, [{
        number: 41,
        html_url: "https://github.com/daniels-project-space/jarvis/pull/41",
        node_id: "PR_node_41",
        draft: true,
        head: { sha: "legacy123" },
      }]))
      .mockResolvedValueOnce(response(200, {
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      }));

    const pull = await openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis",
      branch: "jarvis/legacy-fix",
      title: "Paul: legacy fix",
      body: "Verified evidence",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(pull).toMatchObject({ number: 41, headSha: "legacy123" });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.github.com/graphql");
    expect(String(fetchImpl.mock.calls[1][1]?.body)).toContain("markPullRequestReadyForReview");
  });

  it("merges verified work without bypassing GitHub's checks", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const mergeSha = "fedcba9876543210fedcba9876543210fedcba98";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, [{ filename: "src/app/page.tsx" }]))
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, {
        merged: true,
        sha: mergeSha,
        message: "Pull Request successfully merged",
      }));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: fix",
      token: "token",
      releaseGate: async () => ({ status: "not_required", note: "ordinary code" }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({
      status: "merged",
      sha: mergeSha,
      note: "Pull Request successfully merged",
      providerFinalized: false,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toMatchObject({ sha: headSha });
  });

  it("stops on a real branch conflict instead of force-delivering", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull()))
      .mockResolvedValueOnce(response(200, [{ filename: "src/app/page.tsx" }]))
      .mockResolvedValueOnce(response(200, {
        ...inspectedPull(),
        mergeable: false,
        mergeable_state: "dirty",
      }));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "abc123abc123abc123abc123abc123abc123abcd" },
      title: "Paul: fix",
      token: "token",
      releaseGate: async () => ({ status: "not_required", note: "ordinary code" }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({
      status: "blocked",
      note: "the verified branch conflicts with the current default branch",
    });
  });

  it("never calls GitHub merge when a provider prerequisite fails", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, [{ filename: "convex/schema.ts" }]));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: provider fix",
      token: "token",
      releaseGate: async () => ({ status: "blocked", note: "canonical Convex attestation mismatched" }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ status: "blocked", note: "canonical Convex attestation mismatched" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("does not submit the merge until the exact provider gate is ready", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const mergeSha = "fedcba9876543210fedcba9876543210fedcba98";
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) return response(200, inspectedPull(headSha));
      if (url.includes("/pulls/42/files")) return response(200, [{ filename: "convex/schema.ts" }]);
      if (url.endsWith("/pulls/42/merge") && init?.method === "PUT") {
        events.push("merge");
        return response(200, { merged: true, sha: mergeSha, message: "merged" });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: provider fix",
      token: "token",
      releaseGate: async (change) => {
        events.push("providers-ready");
        expect(change.changedPaths).toEqual(["convex/schema.ts"]);
        return {
          status: "ready",
          note: "exact prerequisites attested",
          headSha,
          baseSha,
          controller: {
            confirmMerge: async (candidate) => {
              events.push("ownership-confirmed");
              expect(candidate).toMatchObject({ headSha, baseSha });
              return { status: "ready", note: "lease renewed" };
            },
            proveLive: async (sha) => {
              events.push("live-proved");
              expect(sha).toBe(mergeSha);
              return { status: "live", note: "exact merge is live" };
            },
            cleanup: async () => { events.push("cleanup"); },
          },
        };
      },
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("merged");
    expect(events).toEqual([
      "providers-ready",
      "ownership-confirmed",
      "merge",
      "live-proved",
      "cleanup",
    ]);
  });

  it("rejects a provider proof for any head other than the exact PR head", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const cleanup = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, [{ filename: "src/trigger/agent-runner.ts" }]));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: provider fix",
      token: "token",
      releaseGate: async () => ({
        status: "ready",
        note: "wrong proof",
        headSha: "f".repeat(40),
        baseSha,
        controller: {
          confirmMerge: async () => ({ status: "ready", note: "must not run" }),
          proveLive: async () => ({ status: "live", note: "must not run" }),
          cleanup,
        },
      }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("blocked");
    expect(result.note).toContain("does not match");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("invalidates predeployment when main advances before the merge PUT", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const advancedBase = "e".repeat(40);
    const confirmMerge = vi.fn(async () => ({ status: "ready" as const, note: "owned" }));
    const cleanup = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull(headSha, baseSha)))
      .mockResolvedValueOnce(response(200, [{ filename: "convex/schema.ts" }]))
      .mockResolvedValueOnce(response(200, inspectedPull(headSha, advancedBase)));

    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: provider fix",
      token: "token",
      releaseGate: async () => ({
        status: "ready",
        note: "predeployment complete",
        headSha,
        baseSha,
        controller: {
          confirmMerge,
          proveLive: async () => ({ status: "live", note: "must not run" }),
          cleanup,
        },
      }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      status: "pending",
      note: "main advanced after provider verification; the exact candidate must be refreshed and re-attested",
    });
    expect(confirmMerge).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves the merge receipt but blocks finalization when exact live proof fails", async () => {
    const headSha = "abc123abc123abc123abc123abc123abc123abcd";
    const mergeSha = "fedcba9876543210fedcba9876543210fedcba98";
    const cleanup = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, [{ filename: "src/trigger/agent-runner.ts" }]))
      .mockResolvedValueOnce(response(200, inspectedPull(headSha)))
      .mockResolvedValueOnce(response(200, { merged: true, sha: mergeSha, message: "merged" }));

    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha },
      title: "Paul: provider fix",
      token: "token",
      releaseGate: async () => ({
        status: "ready",
        note: "predeployment complete",
        headSha,
        baseSha,
        controller: {
          confirmMerge: async () => ({ status: "ready", note: "lease renewed" }),
          proveLive: async () => ({ status: "blocked", note: "production alias still serves an older SHA" }),
          cleanup,
        },
      }),
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      status: "postmerge_pending",
      sha: mergeSha,
      note: "production alias still serves an older SHA",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
