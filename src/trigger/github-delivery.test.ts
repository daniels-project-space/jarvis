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
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, {
      state: "open", merged: false, mergeable: true, mergeable_state: "clean",
      head: { sha: "abc123" }, base: { sha: "base123" },
    })).mockResolvedValueOnce(response(200, {
      merged: true,
      sha: "merge123",
      message: "Pull Request successfully merged",
    }));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "abc123" },
      title: "Paul: fix",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({
      status: "merged",
      sha: "merge123",
      note: "Pull Request successfully merged",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({ sha: "abc123" });
  });

  it("stops on a real branch conflict instead of force-delivering", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, {
        state: "open",
        merged: false,
        mergeable: false,
        mergeable_state: "dirty",
        head: { sha: "new-head" },
      }));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "abc123" },
      title: "Paul: fix",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({
      status: "blocked",
      note: "pull request head changed after controller review; a fresh review is required",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a PR when the reviewed source or default base moved", async () => {
    const fetchImpl = vi.fn()
      // source ref no longer equals the signed receipt head
      .mockResolvedValueOnce(response(200, { object: { sha: "unreviewed-head" } }))
      .mockResolvedValueOnce(response(200, { default_branch: "main" }))
      .mockResolvedValueOnce(response(200, { object: { sha: "reviewed-base" } }));
    const pull = await openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis",
      branch: "jarvis/paul-fix",
      title: "Paul: fix",
      body: "Verified evidence",
      token: "token",
      reviewed: { headSha: "reviewed-head", baseSha: "reviewed-base" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(pull).toBeNull();
    // It did not list/create a pull request after the authority check failed.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never follows a PR head changed by checks or an update-branch operation", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, {
        state: "open", merged: false, mergeable: true, mergeable_state: "behind",
        head: { sha: "reviewed-head" },
      }));
    const result = await mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "reviewed-head" },
      reviewedHeadSha: "reviewed-head",
      title: "Paul: fix",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ status: "blocked", note: "default branch advanced after controller review; a fresh review is required" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a merge request whose initial PR head is not the signed head", async () => {
    const fetchImpl = vi.fn();
    await expect(mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "new-head" },
      reviewedHeadSha: "reviewed-head",
      title: "Paul: fix",
      token: "token",
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ status: "blocked", note: "pull request head is not the reviewed receipt head" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reconciles a lost merge response from the exact reviewed PR without another PUT", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, {
      state: "closed", merged: true, merge_commit_sha: "merge123",
      head: { sha: "reviewed-head" }, base: { sha: "reviewed-base" },
    }));
    await expect(mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis",
      pull: { number: 42, url: "https://github.test/42", headSha: "reviewed-head" },
      reviewedHeadSha: "reviewed-head", reviewedBaseSha: "reviewed-base",
      title: "Paul: fix", token: "token", fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ status: "merged", sha: "merge123", note: "Pull request was already merged" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBeUndefined();
  });
});
