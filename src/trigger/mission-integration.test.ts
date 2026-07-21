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
    prepareMerge: vi.fn(async () => {
      calls.push("SANDBOX_MERGE");
      return options.conflict ? { status: "conflict" as const, reason: "content conflict" }
        : { status: "clean" as const, headSha: MERGED, treeSha: MERGED_TREE, synthetic: false };
    }),
    stageCandidate: vi.fn(async () => ({ outcome: "applied" as const, providerHeadSha: MERGED })),
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
    expect(h.calls.filter((call) => call === "GRAPHQL")).toHaveLength(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "update_ref", expectedBaseSha: BASE, headSha: MERGED }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "applied", providerHeadSha: MERGED }));
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
      prepare: vi.fn().mockResolvedValue({ replay: false }), observe: vi.fn(),
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

  it("prechecks a stale integration ref before synthetic staging or effect preparation", async () => {
    const h = harness({ integration: "f".repeat(40) });
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true, candidate: {},
    });
    const prepare = vi.fn();
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe: vi.fn() })).resolves.toMatchObject({ status: "stale" });
    expect(h.adapter.stageCandidate).not.toHaveBeenCalled();
    expect(h.adapter.prepareRefEffect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reconstructs and observes only the final effect when the deterministic head already exists", async () => {
    const h = harness({ integration: MERGED });
    vi.mocked(h.adapter.prepareMerge).mockResolvedValue({
      status: "clean", headSha: MERGED, treeSha: MERGED_TREE, synthetic: true, candidate: {},
    });
    const prepare = vi.fn().mockResolvedValue({ replay: true, observation: "unknown" });
    const observe = vi.fn().mockResolvedValue(true);
    await expect(integrateReviewedWorker(receipt, h.adapter, { prepare, observe })).resolves.toMatchObject({ status: "integrated" });
    expect(h.adapter.stageCandidate).not.toHaveBeenCalled();
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
