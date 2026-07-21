import { describe, expect, it, vi } from "vitest";
import {
  continueRepositoryDelivery,
  mergeVerifiedPullRequest,
  openDeliveryPullRequest,
  type DeliveryEffect,
  type PullRequestDelivery,
  validatedGoalDeliveryBranch,
} from "./github-delivery";

const HEAD = "reviewed-head";
const BASE = "reviewed-base";
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const payload = (overrides: Record<string, unknown> = {}) => ({
  number: 42, html_url: "https://github.test/pulls/42", node_id: "PR_node_42", draft: false,
  state: "open", merged: false, mergeable: true, mergeable_state: "clean",
  head: { sha: HEAD }, base: { sha: BASE }, ...overrides,
});
const pull = (overrides: Partial<PullRequestDelivery> = {}): PullRequestDelivery => ({
  number: 42, url: "https://github.test/pulls/42", nodeId: "PR_node_42", draft: false,
  headSha: HEAD, baseSha: BASE, ...overrides,
});
const refs = (fetchImpl: ReturnType<typeof vi.fn>, head = HEAD, base = BASE) => {
  fetchImpl.mockResolvedValueOnce(response(200, { object: { sha: head } }));
  fetchImpl.mockResolvedValueOnce(response(200, { default_branch: "main" }));
  fetchImpl.mockResolvedValueOnce(response(200, { object: { sha: base } }));
};
const writes = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls.filter(
  (call) => ["POST", "PUT", "PATCH", "DELETE"].includes(String(call[1]?.method)),
);

describe("exact GitHub delivery adapter", () => {
  it("retains only a validator's scoped goal branch", () => {
    expect(validatedGoalDeliveryBranch({ goalStage: "validating", branch: "jarvis/goal-123" })).toBe("jarvis/goal-123");
    expect(validatedGoalDeliveryBranch({ goalStage: "building", branch: "jarvis/goal-123" })).toBe("");
    expect(validatedGoalDeliveryBranch({ goalStage: "validating", branch: "main" })).toBe("");
  });

  it.each([
    ["source", "moved-head", BASE],
    ["base", HEAD, "moved-base"],
  ])("rejects a moved %s ref before a new write", async (_label, head, base) => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, []));
    refs(fetchImpl, head, base);
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("rejects an existing PR whose base is not the signed base", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [payload({ base: { sha: "other-base" } })]));
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("refuses to adopt an unrelated ready PR even when its refs happen to match", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [payload()]));
    const prepareEffect = vi.fn().mockResolvedValue(null);
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, prepareEffect,
      observeEffect: vi.fn(), fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBeNull();
    expect(prepareEffect).toHaveBeenCalledTimes(2);
    expect(prepareEffect.mock.calls.every((call) => call[1]?.reconcileOnly === true)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("recognizes an exact manual draft through a durable applied observation and never promotes it", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [payload({ draft: true })]));
    const prepareEffect = vi.fn().mockResolvedValue({ replay: false });
    const observeEffect = vi.fn();
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", draft: true, reviewed: { headSha: HEAD, baseSha: BASE },
      prepareEffect, observeEffect, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual(pull({ draft: true }));
    expect(prepareEffect.mock.calls[0][0]).toMatchObject({ kind: "create_draft_pr" });
    expect(observeEffect).toHaveBeenCalledWith(expect.anything(), "applied", pull({ draft: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("reconciles a lost create response with one POST and exact full identity", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [])); refs(fetchImpl);
    fetchImpl.mockRejectedValueOnce(new Error("response lost"));
    fetchImpl.mockResolvedValueOnce(response(200, [payload({ draft: true })]));
    const observeEffect = vi.fn();
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", draft: true, reviewed: { headSha: HEAD, baseSha: BASE },
      prepareEffect: async () => ({ replay: false }), observeEffect, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual(pull({ draft: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(writes(fetchImpl)).toHaveLength(1);
    expect(observeEffect).toHaveBeenLastCalledWith(expect.anything(), "applied", pull({ draft: true }));
  });

  it("rejects a lost-create recovery whose observed PR base does not match", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [])); refs(fetchImpl);
    fetchImpl.mockRejectedValueOnce(new Error("response lost"));
    fetchImpl.mockResolvedValueOnce(response(200, [payload({ draft: true, base: { sha: "other-base" } })]));
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", draft: true, reviewed: { headSha: HEAD, baseSha: BASE },
      prepareEffect: async () => ({ replay: false }), observeEffect: vi.fn(), fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(writes(fetchImpl)).toHaveLength(1);
  });

  it("reconciles a lost promote response with one POST and no duplicate promotion", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [payload({ draft: true })]));
    refs(fetchImpl); fetchImpl.mockResolvedValueOnce(response(200, payload({ draft: true })));
    fetchImpl.mockRejectedValueOnce(new Error("response lost"));
    fetchImpl.mockResolvedValueOnce(response(200, payload({ draft: false })));
    const observeEffect = vi.fn();
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE },
      prepareEffect: async () => ({ replay: false }), observeEffect, fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual(pull());
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(writes(fetchImpl)).toHaveLength(1);
    expect(String(writes(fetchImpl)[0][0])).toContain("graphql");
    expect(observeEffect).toHaveBeenLastCalledWith(expect.anything(), "applied", pull());
  });

  it("reconciles a lost merge response with one PUT and records that same effect applied", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, payload()))
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(response(200, payload({
        state: "closed", merged: true, merge_commit_sha: "merge-sha",
      })));
    const observeEffect = vi.fn();
    await expect(mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis", pull: pull(), title: "work", token: "token",
      reviewedHeadSha: HEAD, reviewedBaseSha: BASE, fetchImpl: fetchImpl as typeof fetch,
      prepareEffect: async () => ({ replay: false }), observeEffect,
    })).resolves.toMatchObject({ status: "merged", sha: "merge-sha" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(writes(fetchImpl).map((call) => call[1]?.method)).toEqual(["PUT"]);
    expect(observeEffect).toHaveBeenLastCalledWith(expect.anything(), "applied", pull({ mergeCommitSha: "merge-sha" }));
  });

  it("reconciles an already-applied prepared merge and rejects a mismatched completed PR", async () => {
    const applied = vi.fn();
    const exactFetch = vi.fn().mockResolvedValueOnce(response(200, payload({
      state: "closed", merged: true, merge_commit_sha: "merge-sha",
    })));
    await expect(mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis", pull: pull(), title: "work", token: "token",
      reviewedHeadSha: HEAD, reviewedBaseSha: BASE, fetchImpl: exactFetch as typeof fetch,
      prepareEffect: async (_effect, options) => options?.reconcileOnly ? { replay: true, observation: "unknown" } : null,
      observeEffect: applied,
    })).resolves.toMatchObject({ status: "merged", sha: "merge-sha" });
    expect(writes(exactFetch)).toHaveLength(0);
    expect(applied).toHaveBeenCalledTimes(1);

    const mismatchFetch = vi.fn().mockResolvedValueOnce(response(200, payload({
      state: "closed", merged: true, merge_commit_sha: "merge-sha", base: { sha: "other-base" },
    })));
    await expect(mergeVerifiedPullRequest({
      repo: "daniels-project-space/jarvis", pull: pull(), title: "work", token: "token",
      reviewedHeadSha: HEAD, reviewedBaseSha: BASE, fetchImpl: mismatchFetch as typeof fetch,
    })).resolves.toMatchObject({ status: "blocked" });
    expect(writes(mismatchFetch)).toHaveLength(0);
  });

  it("recovers provider success after durable observation rejection without repeating the POST", async () => {
    const prepared = new Map<string, DeliveryEffect>();
    let rejectObservation = true;
    const prepareEffect = vi.fn(async (effect: DeliveryEffect, options?: { reconcileOnly?: boolean }) => {
      if (prepared.has(effect.effectId)) return { replay: true, observation: "unknown" as const };
      if (options?.reconcileOnly) return null;
      prepared.set(effect.effectId, effect);
      return { replay: false };
    });
    const observeEffect = vi.fn(async () => {
      if (rejectObservation) throw new Error("Convex observation rejected");
    });
    const firstFetch = vi.fn().mockResolvedValueOnce(response(200, []));
    refs(firstFetch);
    firstFetch.mockResolvedValueOnce(response(201, payload()));
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, prepareEffect, observeEffect,
      fetchImpl: firstFetch as typeof fetch,
    })).rejects.toThrow("Convex observation rejected");
    expect(writes(firstFetch)).toHaveLength(1);

    rejectObservation = false;
    const replayFetch = vi.fn().mockResolvedValueOnce(response(200, [payload()]));
    await expect(openDeliveryPullRequest({
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, prepareEffect, observeEffect,
      fetchImpl: replayFetch as typeof fetch,
    })).resolves.toEqual(pull());
    expect(writes(replayFetch)).toHaveLength(0);
    expect([...writes(firstFetch), ...writes(replayFetch)]).toHaveLength(1);
  });
});

describe("real controller continuation caller", () => {
  it("supplies preparation and observation for a protected draft write", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, [])); refs(fetchImpl);
    fetchImpl.mockResolvedValueOnce(response(201, payload({ draft: true })));
    const events: string[] = [];
    await expect(continueRepositoryDelivery({
      policy: "manual", branchChanged: true, repo: "daniels-project-space/jarvis", branch: "jarvis/work",
      title: "work", body: "evidence", token: "token", reviewed: { headSha: HEAD, baseSha: BASE },
      fetchImpl: fetchImpl as typeof fetch,
      prepareEffect: async (effect) => { events.push(`prepare:${effect.kind}`); return { replay: false }; },
      observeEffect: async (effect, observation) => { events.push(`observe:${effect.kind}:${observation}`); },
    })).resolves.toMatchObject({ ok: true, outcome: "protected_draft" });
    expect(events).toEqual(["prepare:create_draft_pr", "observe:create_draft_pr:applied"]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(writes(fetchImpl).map((call) => call[1]?.method)).toEqual(["POST"]);
  });

  it("supplies preparation and observation for create and merge writes", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(response(200, [])); refs(fetchImpl);
    fetchImpl.mockResolvedValueOnce(response(201, payload()));
    fetchImpl.mockResolvedValueOnce(response(200, payload()));
    fetchImpl.mockResolvedValueOnce(response(200, { merged: true, sha: "merge-sha" }));
    fetchImpl.mockResolvedValueOnce(response(200, payload({ state: "closed", merged: true, merge_commit_sha: "merge-sha" })));
    const events: string[] = [];
    const result = await continueRepositoryDelivery({
      policy: "auto_merge", branchChanged: true, repo: "daniels-project-space/jarvis", branch: "jarvis/work",
      title: "work", body: "evidence", token: "token", reviewed: { headSha: HEAD, baseSha: BASE },
      fetchImpl: fetchImpl as typeof fetch, prepareEffect: async (effect) => {
        events.push(`prepare:${effect.kind}`); return { replay: false };
      }, observeEffect: async (effect, observation) => { events.push(`observe:${effect.kind}:${observation}`); },
    });
    expect(result).toMatchObject({ ok: true, outcome: "merged", mergeCommitSha: "merge-sha" });
    expect(events).toEqual([
      "prepare:create_pr", "observe:create_pr:applied",
      "prepare:merge_pr", "observe:merge_pr:applied",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(writes(fetchImpl).map((call) => call[1]?.method)).toEqual(["POST", "PUT"]);
  });

  it("reconciles a prepared merge by exact PR number after the default branch moved", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/daniels-project-space/jarvis/pulls/42");
      expect(init?.method).toBeUndefined();
      return response(200, payload({ state: "closed", merged: true, merge_commit_sha: "merge-sha" }));
    });
    const observeEffect = vi.fn();
    await expect(continueRepositoryDelivery({
      policy: "auto_merge", branchChanged: false, reconcileMerge: true,
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, expectedPull: pull(),
      fetchImpl: fetchImpl as typeof fetch,
      prepareEffect: async (_effect, options) => options?.reconcileOnly ? { replay: true, observation: "unknown" } : null,
      observeEffect,
    })).resolves.toMatchObject({ ok: true, outcome: "merged", mergeCommitSha: "merge-sha" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writes(fetchImpl)).toHaveLength(0);
    expect(observeEffect).toHaveBeenCalledTimes(1);
    expect(observeEffect).toHaveBeenCalledWith(expect.objectContaining({ kind: "merge_pr" }), "applied", pull({ mergeCommitSha: "merge-sha" }));
  });

  it.each([
    ["missing", undefined],
    ["wrong head", pull({ headSha: "wrong-head" })],
    ["wrong base", pull({ baseSha: "wrong-base" })],
    ["draft", pull({ draft: true })],
    ["wrong url", pull({ url: "https://github.test/pulls/other" })],
    ["wrong node", pull({ nodeId: "wrong-node" })],
    ["wrong number", pull({ number: 41 })],
  ] as const)("fails closed for %s prepared-merge identity with zero writes", async (_label, expectedPull) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, payload({
      state: "closed", merged: true, merge_commit_sha: "merge-sha",
    })));
    await expect(continueRepositoryDelivery({
      policy: "auto_merge", branchChanged: false, reconcileMerge: true,
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, expectedPull,
      fetchImpl: fetchImpl as typeof fetch,
      prepareEffect: async () => ({ replay: true, observation: "unknown" }), observeEffect: vi.fn(),
    })).resolves.toMatchObject({ ok: false });
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("replays the same prepared merge response without any provider write", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, payload({ state: "closed", merged: true, merge_commit_sha: "merge-sha" })))
      .mockResolvedValueOnce(response(200, payload({ state: "closed", merged: true, merge_commit_sha: "merge-sha" })));
    const prepareEffect = vi.fn(async () => ({ replay: true, observation: "applied" as const }));
    const observeEffect = vi.fn();
    const args = {
      policy: "auto_merge" as const, branchChanged: false, reconcileMerge: true,
      repo: "daniels-project-space/jarvis", branch: "jarvis/work", title: "work", body: "evidence",
      token: "token", reviewed: { headSha: HEAD, baseSha: BASE }, expectedPull: pull(),
      fetchImpl: fetchImpl as typeof fetch, prepareEffect, observeEffect,
    };
    await expect(continueRepositoryDelivery(args)).resolves.toMatchObject({ ok: true, outcome: "merged" });
    await expect(continueRepositoryDelivery(args)).resolves.toMatchObject({ ok: true, outcome: "merged" });
    expect(prepareEffect).toHaveBeenCalledTimes(2);
    expect(observeEffect).toHaveBeenCalledTimes(2);
    expect(writes(fetchImpl)).toHaveLength(0);
  });

  it("supplies preparation and observation for promotion and merge writes", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, [payload({ draft: true })]));
    refs(fetchImpl);
    fetchImpl.mockResolvedValueOnce(response(200, payload({ draft: true })));
    fetchImpl.mockResolvedValueOnce(response(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    fetchImpl.mockResolvedValueOnce(response(200, payload()));
    fetchImpl.mockResolvedValueOnce(response(200, payload()));
    fetchImpl.mockResolvedValueOnce(response(200, { merged: true, sha: "merge-sha" }));
    fetchImpl.mockResolvedValueOnce(response(200, payload({ state: "closed", merged: true, merge_commit_sha: "merge-sha" })));
    const events: string[] = [];
    await expect(continueRepositoryDelivery({
      policy: "auto_merge", branchChanged: true, repo: "daniels-project-space/jarvis", branch: "jarvis/work",
      title: "work", body: "evidence", token: "token", reviewed: { headSha: HEAD, baseSha: BASE },
      fetchImpl: fetchImpl as typeof fetch,
      prepareEffect: async (effect) => { events.push(`prepare:${effect.kind}`); return { replay: false }; },
      observeEffect: async (effect, observation) => { events.push(`observe:${effect.kind}:${observation}`); },
    })).resolves.toMatchObject({ ok: true, outcome: "merged", mergeCommitSha: "merge-sha" });
    expect(events).toEqual([
      "prepare:promote_pr", "observe:promote_pr:applied",
      "prepare:merge_pr", "observe:merge_pr:applied",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(writes(fetchImpl).map((call) => call[1]?.method)).toEqual(["POST", "PUT"]);
  });

  it.each([
    ["read_only", true, "read_only_complete"],
    ["manual", false, "no_change"],
    ["auto_merge", false, "no_change"],
  ] as const)("enforces %s without any GitHub call when branchChanged=%s", async (policy, branchChanged, outcome) => {
    const fetchImpl = vi.fn();
    await expect(continueRepositoryDelivery({
      policy, branchChanged, repo: "daniels-project-space/jarvis", branch: "jarvis/work",
      title: "work", body: "evidence", token: "", reviewed: { headSha: HEAD, baseSha: BASE },
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({ ok: true, outcome, providerCall: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
