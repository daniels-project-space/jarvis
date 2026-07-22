import { describe, expect, it, vi } from "vitest";
import { integrateReviewedWorker, type IntegrationAdapter, type ProviderEffect } from "./mission-integration";

const BASE = "a".repeat(40);
const WORKER = "b".repeat(40);
const WORKER_TREE = "c".repeat(40);
const MERGED = "d".repeat(40);
const MERGED_TREE = "e".repeat(40);
const receipt = {
  integrationAttemptId: "integration-1",
  workerBranch: "jarvis/work/goal/catalog-job-a", reviewedHeadSha: WORKER,
  reviewedHeadTreeSha: WORKER_TREE, expectedIntegrationBaseSha: BASE,
  expectedIntegrationRefSha: BASE,
  integrationBranch: "jarvis/goal/catalog", generation: 1,
};

function refEffect(input: { effectId: string; branch: string; expectedBaseSha: string; newHeadSha: string; treeSha: string }): ProviderEffect {
  return {
    effectId: input.effectId, kind: "update_ref", provider: "github", providerIdentity: `R:${input.branch}`,
    method: "POST", target: "graphql:updateRefs", requestDigest: "9".repeat(64),
    expectedBaseSha: input.expectedBaseSha, headSha: input.newHeadSha, treeSha: input.treeSha,
  };
}

function harness(options: { integration?: string | null; advance?: "applied" | "not_applied" | "unknown"; conflict?: boolean } = {}) {
  const calls: string[] = [];
  const refs = new Map([[receipt.workerBranch, WORKER]]);
  if (options.integration !== null) refs.set(receipt.integrationBranch, options.integration ?? BASE);
  const adapter: IntegrationAdapter = {
    readRef: vi.fn(async (branch: string) => { calls.push("GET"); return refs.get(branch) ?? null; }),
    attestDeploymentFence: vi.fn(async () => { calls.push("ATTEST"); }),
    prepareMerge: vi.fn(async () => {
      calls.push("SANDBOX_MERGE");
      return options.conflict ? { status: "conflict" as const, reason: "content conflict" }
        : { status: "clean" as const, headSha: MERGED, treeSha: MERGED_TREE, synthetic: false };
    }),
    stageCandidate: vi.fn(async () => {
      calls.push("STAGE");
      return { outcome: "applied" as const, providerHeadSha: MERGED };
    }),
    prepareRefEffect: vi.fn(async (input) => refEffect(input)),
    advanceRef: vi.fn(async ({ newHeadSha }) => {
      calls.push("GRAPHQL");
      if (options.advance !== "not_applied") refs.set(receipt.integrationBranch, newHeadSha);
      return { outcome: options.advance ?? "applied", providerHeadSha: options.advance === "not_applied" ? undefined : newHeadSha };
    }),
  };
  return { adapter, calls, refs };
}

describe("serialized integration provider protocol", () => {
  it("performs one exact ref effect with mechanical reads", async () => {
    const h = harness();
    const prepare = vi.fn().mockResolvedValue({ replay: false });
    const observe = vi.fn().mockResolvedValue(true);
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toEqual({
      status: "integrated", effectId: `update-ref:${receipt.integrationAttemptId}:${MERGED}`,
      headSha: MERGED, treeSha: MERGED_TREE,
    });
    expect(h.calls.filter((call) => call === "GET")).toHaveLength(4);
    expect(h.calls.filter((call) => call === "ATTEST")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(1);
    expect(h.calls.indexOf("ATTEST")).toBeLessThan(h.calls.indexOf("GRAPHQL"));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "update_ref", expectedBaseSha: BASE, headSha: MERGED }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "applied", providerHeadSha: MERGED }));
  });

  it("attests the exact synthetic candidate before staging it and advancing the ref", async () => {
    const h = harness();
    const candidate = { headSha: MERGED, treeSha: MERGED_TREE };
    vi.mocked(h.adapter.prepareMerge).mockImplementation(async () => {
      h.calls.push("SANDBOX_MERGE");
      return { status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true, candidate };
    });
    const prepare = vi.fn().mockResolvedValue({ replay: false });
    const observe = vi.fn().mockResolvedValue(true);

    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({
      status: "integrated", headSha: MERGED, treeSha: MERGED_TREE,
    });

    expect(h.adapter.attestDeploymentFence).toHaveBeenCalledWith({ headSha: MERGED, treeSha: MERGED_TREE });
    expect(h.adapter.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ synthetic: true, headSha: MERGED, treeSha: MERGED_TREE, candidate }),
      { prepare, observe },
    );
    expect(h.adapter.advanceRef).toHaveBeenCalledTimes(1);
    expect(h.calls.indexOf("ATTEST")).toBeLessThan(h.calls.indexOf("STAGE"));
    expect(h.calls.indexOf("STAGE")).toBeLessThan(h.calls.indexOf("GRAPHQL"));
  });

  it("reconciles a lost ref response and never sends a second write", async () => {
    const h = harness({ advance: "unknown" });
    const result = await integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: false }), observe: vi.fn().mockResolvedValue(true),
    });
    expect(result.status).toBe("integrated");
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "GET")).toHaveLength(5);
  });

  it("reconciles a controller crash after preparation without a duplicate write", async () => {
    const h = harness({ integration: MERGED });
    const result = await integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }), observe: vi.fn().mockResolvedValue(true),
    });
    expect(result.status).toBe("integrated");
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(0);
  });

  it("drains a lost synthetic-blob observation before an already-applied final ref", async () => {
    const h = harness({ integration: MERGED });
    const blobSha = "1".repeat(40);
    const blobEffect: ProviderEffect = {
      effectId: `stage-blob:${receipt.integrationAttemptId}:${blobSha}`,
      kind: "stage_blob", provider: "github", providerIdentity: `R:blob:${blobSha}`,
      method: "POST", target: "/git/blobs", requestDigest: "8".repeat(64),
      headSha: blobSha, treeSha: MERGED_TREE,
    };
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", synthetic: true, headSha: MERGED, treeSha: MERGED_TREE, candidate: { blobSha },
    });
    let providerWrites = 0;
    vi.mocked(h.adapter.stageCandidate).mockImplementation(async (_prepared, hooks) => {
      const durable = await hooks.prepare(blobEffect);
      if (!durable) return { outcome: "unknown" };
      if (!hooks.reconcileOnly) providerWrites += 1;
      const observed = await hooks.observe({
        effectId: blobEffect.effectId, observation: "applied", providerHeadSha: blobSha,
        providerResponse: "reconciled:exact-object",
      });
      return observed
        ? { outcome: "applied", providerHeadSha: MERGED }
        : { outcome: "unknown", providerResponse: "durable-observation-fence-lost" };
    });
    const observations = new Map<string, string | null>([[blobEffect.effectId, null]]);
    const prepare = vi.fn(async (effect: ProviderEffect) => ({
      replay: observations.has(effect.effectId), observation: observations.get(effect.effectId) ?? null,
    }));
    const observe = vi.fn(async (observation: { effectId: string; observation: string }) => {
      observations.set(observation.effectId, observation.observation);
      return true;
    });

    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({
      status: "integrated", headSha: MERGED,
    });
    expect(h.adapter.stageCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reconcileOnly: true }));
    expect(observations.get(blobEffect.effectId)).toBe("applied");
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(0);
    expect(providerWrites).toBe(0);
  });

  it("fails closed when a reconciled provider observation cannot be persisted", async () => {
    const h = harness({ integration: MERGED });
    const result = await integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }), observe: vi.fn().mockResolvedValue(false),
    });
    expect(result).toMatchObject({ status: "pending" });
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(0);
  });

  it.each([
    ["moved worker", { worker: "f".repeat(40), integration: BASE }, "stale"],
    ["rolled-back integration", { worker: WORKER, integration: "f".repeat(40) }, "stale"],
  ])("rejects %s without a provider write", async (_label, state, expected) => {
    const h = harness({ integration: state.integration });
    h.refs.set(receipt.workerBranch, state.worker);
    const result = await integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: false }), observe: vi.fn().mockResolvedValue(true),
    });
    expect(result.status).toBe(expected);
    expect(h.calls).not.toContain("GRAPHQL");
  });

  it("turns a semantic conflict into a focused result without touching the ref", async () => {
    const h = harness({ conflict: true });
    const result = await integrateReviewedWorker(receipt, h.adapter, { prepare: vi.fn(), observe: vi.fn() });
    expect(result).toMatchObject({ status: "conflict", reason: "content conflict" });
    expect(h.calls).not.toContain("GRAPHQL");
  });

  it("rejects an unfenced synthetic candidate with zero effect preparation, staging, or ref advancement", async () => {
    const h = harness();
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true,
      candidate: { headSha: MERGED, treeSha: MERGED_TREE },
    });
    vi.mocked(h.adapter.attestDeploymentFence).mockRejectedValue(new Error("candidate vercel.json is missing"));
    const prepare = vi.fn();
    const result = await integrateReviewedWorker(receipt, h.adapter, { prepare, observe: vi.fn() });
    expect(result).toMatchObject({ status: "pending", reason: expect.stringContaining("failed closed") });
    expect(h.adapter.prepareRefEffect).not.toHaveBeenCalled();
    expect(h.adapter.stageCandidate).not.toHaveBeenCalled();
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("GRAPHQL");
  });

  it("records a fresh stale integration ref as not-applied before synthetic staging", async () => {
    const h = harness({ integration: "f".repeat(40) });
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true, candidate: {},
    });
    const prepare = vi.fn().mockResolvedValue({ replay: false, observation: null });
    const observe = vi.fn().mockResolvedValue(true);
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({ status: "stale" });
    expect(h.adapter.stageCandidate).not.toHaveBeenCalled();
    expect(h.adapter.prepareRefEffect).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied", providerHeadSha: "f".repeat(40) }));
  });

  it("durably observes not-applied when the worker moves after final preparation but before updateRefs", async () => {
    const h = harness();
    const observe = vi.fn().mockResolvedValue(true);
    const prepare = vi.fn(async () => {
      h.refs.set(receipt.workerBranch, "f".repeat(40));
      return { replay: false, observation: null };
    });
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({
      status: "stale", reason: "worker head moved after durable preparation",
    });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied" }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
  });

  it("reloads a prior final preparation and records not-applied when the worker moved before replay", async () => {
    const h = harness();
    h.refs.set(receipt.workerBranch, "f".repeat(40));
    const observe = vi.fn().mockResolvedValue(true);
    const preparedReceipt = {
      ...receipt, preparedEffectId: `update-ref:${receipt.integrationAttemptId}:${MERGED}`,
      preparedIntegrationHeadSha: MERGED, preparedIntegrationTreeSha: MERGED_TREE,
    };
    await expect(integrateReviewedWorker(preparedReceipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }), observe,
    })).resolves.toMatchObject({ status: "stale", reason: expect.stringContaining("after final preparation") });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied" }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
  });

  it("holds a prior final preparation when both the worker and provider ref moved ambiguously", async () => {
    const third = "f".repeat(40);
    const h = harness({ integration: third });
    h.refs.set(receipt.workerBranch, "1".repeat(40));
    const observe = vi.fn().mockResolvedValue(true);
    const preparedReceipt = {
      ...receipt, preparedEffectId: `update-ref:${receipt.integrationAttemptId}:${MERGED}`,
      preparedIntegrationHeadSha: MERGED, preparedIntegrationTreeSha: MERGED_TREE,
    };
    await expect(integrateReviewedWorker(preparedReceipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }), observe,
    })).resolves.toMatchObject({ status: "pending", reason: expect.stringContaining("ambiguous") });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "unknown", providerHeadSha: third }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
  });

  it("durably observes not-applied when the integration ref moves after fresh final preparation", async () => {
    const h = harness();
    const third = "f".repeat(40);
    const observe = vi.fn().mockResolvedValue(true);
    const prepare = vi.fn(async () => {
      h.refs.set(receipt.integrationBranch, third);
      return { replay: false, observation: null };
    });
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({ status: "stale" });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied", providerHeadSha: third }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
  });

  it("holds an ambiguous replay whose ref moves to neither base nor prepared head", async () => {
    const h = harness();
    const third = "f".repeat(40);
    const observe = vi.fn().mockResolvedValue(true);
    const prepare = vi.fn(async () => {
      h.refs.set(receipt.integrationBranch, third);
      return { replay: true, observation: "unknown" };
    });
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({
      status: "pending", reason: expect.stringContaining("ambiguous"),
    });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "unknown", providerHeadSha: third }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
  });

  it("drains synthetic staging read-only before observing an existing deterministic final ref", async () => {
    const h = harness({ integration: MERGED });
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true, candidate: {},
    });
    const prepare = vi.fn().mockResolvedValue({ replay: true, observation: "unknown" });
    const observe = vi.fn().mockResolvedValue(true);
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({ status: "integrated" });
    expect(h.adapter.stageCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reconcileOnly: true }));
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "applied", providerHeadSha: MERGED }));
  });

  it("reconcile-only control observes a prepared final effect at the base without resending it", async () => {
    const h = harness();
    const observe = vi.fn().mockResolvedValue(true);
    await expect(integrateReviewedWorker(receipt, h.adapter, {
      reconcileOnly: true, prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }), observe,
    })).resolves.toMatchObject({ status: "pending" });
    expect(h.adapter.advanceRef).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied" }));
  });

  it("reconciles a provider callback barrier race without a second final write", async () => {
    const h = harness();
    let release!: () => void;
    let applied!: () => void;
    const providerApplied = new Promise<void>((resolve) => { applied = resolve; });
    const callbackBarrier = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(h.adapter.advanceRef).mockImplementation(async ({ newHeadSha }) => {
      h.refs.set(receipt.integrationBranch, newHeadSha);
      applied();
      await callbackBarrier;
      return { outcome: "applied", providerHeadSha: newHeadSha };
    });
    const first = integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: false }), observe: vi.fn().mockResolvedValue(false),
    });
    await providerApplied;
    const reconciled = await integrateReviewedWorker(receipt, h.adapter, {
      reconcileOnly: true, prepare: vi.fn().mockResolvedValue({ replay: true, observation: null }), observe: vi.fn().mockResolvedValue(true),
    });
    expect(reconciled).toMatchObject({ status: "integrated", headSha: MERGED });
    expect(h.adapter.advanceRef).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ status: "pending" });
  });

  it("never resends while the first provider callback drains and later reconciles the exact head", async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const callbackBarrier = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(h.adapter.advanceRef).mockImplementation(async ({ newHeadSha }) => {
      entered();
      await callbackBarrier;
      h.refs.set(receipt.integrationBranch, newHeadSha);
      return { outcome: "applied", providerHeadSha: newHeadSha };
    });
    const first = integrateReviewedWorker(receipt, h.adapter, {
      prepare: vi.fn().mockResolvedValue({ replay: false }), observe: vi.fn().mockResolvedValue(false),
    });
    await providerEntered;

    const earlyObserve = vi.fn().mockResolvedValue(true);
    const early = await integrateReviewedWorker(receipt, h.adapter, {
      reconcileOnly: true,
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: null }),
      observe: earlyObserve,
    });
    expect(early).toMatchObject({ status: "pending" });
    expect(earlyObserve).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied" }));
    expect(h.adapter.advanceRef).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ status: "pending" });
    const settled = await integrateReviewedWorker(receipt, h.adapter, {
      reconcileOnly: true,
      prepare: vi.fn().mockResolvedValue({ replay: true, observation: "unknown" }),
      observe: vi.fn().mockResolvedValue(true),
    });
    expect(settled).toMatchObject({ status: "integrated", headSha: MERGED });
    expect(h.adapter.advanceRef).toHaveBeenCalledTimes(1);
  });
});
