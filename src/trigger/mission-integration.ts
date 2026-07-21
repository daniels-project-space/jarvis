export const ZERO_OID = "0".repeat(40);

export type IntegrationReceipt = Readonly<{
  integrationAttemptId: string;
  workerBranch: string;
  reviewedHeadSha: string;
  reviewedHeadTreeSha: string;
  expectedIntegrationBaseSha: string;
  expectedIntegrationRefSha: string;
  integrationBranch: string;
  generation: number;
}>;

export type ProviderEffect = Readonly<{
  effectId: string;
  kind: "stage_blob" | "stage_tree" | "stage_commit" | "update_ref";
  provider: "github";
  providerIdentity: string;
  method: "POST";
  target: string;
  requestDigest: string;
  expectedBaseSha?: string;
  headSha: string;
  treeSha: string;
}>;

export type ProviderObservation = Readonly<{
  effectId: string;
  observation: "applied" | "not_applied" | "unknown";
  providerHeadSha?: string;
  providerResponse?: string;
}>;

export type PreparedIntegration = Readonly<{
  status: "clean" | "conflict" | "stale" | "deferred";
  headSha?: string;
  treeSha?: string;
  synthetic?: boolean;
  candidate?: unknown;
  reason?: string;
}>;

export type ProviderWriteResult = Readonly<{
  outcome: "applied" | "not_applied" | "unknown";
  providerHeadSha?: string;
  providerResponse?: string;
}>;

export type IntegrationHooks = Readonly<{
  prepare(effect: ProviderEffect): Promise<{ replay: boolean; observation?: string | null } | null>;
  observe(observation: ProviderObservation): Promise<boolean>;
  reconcileOnly?: boolean;
}>;

export type IntegrationAdapter = Readonly<{
  readRef(branch: string): Promise<string | null>;
  prepareMerge(input: {
    integrationBaseSha: string;
    workerHeadSha: string;
    workerTreeSha: string;
    generation: number;
  }): Promise<PreparedIntegration>;
  stageCandidate(prepared: PreparedIntegration, hooks: IntegrationHooks): Promise<ProviderWriteResult>;
  prepareRefEffect(input: {
    effectId: string;
    branch: string;
    expectedBaseSha: string;
    newHeadSha: string;
    treeSha: string;
  }): Promise<ProviderEffect>;
  advanceRef(input: {
    effectId: string;
    branch: string;
    expectedBaseSha: string;
    newHeadSha: string;
  }): Promise<ProviderWriteResult>;
}>;

export type IntegrationResult =
  | { status: "integrated"; effectId: string; headSha: string; treeSha: string }
  | { status: "conflict" | "stale" | "pending"; reason: string };

function expectedObservedRef(expected: string) {
  return expected === ZERO_OID ? null : expected;
}

/**
 * Every GitHub write crosses its own durable prepare/observe boundary. A
 * synthetic object is staged before the final updateRefs compare-and-set;
 * response-loss recovery observes exact immutable identities before retrying.
 */
export async function integrateReviewedWorker(
  receipt: IntegrationReceipt,
  adapter: IntegrationAdapter,
  hooks: IntegrationHooks,
): Promise<IntegrationResult> {
  try {
    const workerHead = await adapter.readRef(receipt.workerBranch);
    if (workerHead !== receipt.reviewedHeadSha) {
      return { status: "stale", reason: `reviewed worker head moved: expected ${receipt.reviewedHeadSha}, observed ${workerHead ?? "missing"}` };
    }
    const expectedRef = expectedObservedRef(receipt.expectedIntegrationRefSha);
    const observedIntegration = await adapter.readRef(receipt.integrationBranch);
    const merged = await adapter.prepareMerge({
      integrationBaseSha: receipt.expectedIntegrationBaseSha,
      workerHeadSha: receipt.reviewedHeadSha,
      workerTreeSha: receipt.reviewedHeadTreeSha,
      generation: receipt.generation,
    });
    if (merged.status === "conflict") return { status: "conflict", reason: merged.reason ?? "semantic merge conflict" };
    if (merged.status === "stale") return { status: "stale", reason: merged.reason ?? "reviewed worker identity changed" };
    if (merged.status === "deferred" || !merged.headSha || !merged.treeSha) {
      return { status: "pending", reason: merged.reason ?? "integration sandbox could not prepare the exact merge" };
    }

    // Deterministic preparation is read-only.  Fence a stale provider ref
    // before creating any synthetic object or durable staging-effect row.
    if (observedIntegration !== expectedRef && observedIntegration !== merged.headSha) {
      if (hooks.reconcileOnly && merged.synthetic) await adapter.stageCandidate(merged, hooks);
      return { status: "stale", reason: `integration ref changed: expected ${expectedRef ?? "absent"}, observed ${observedIntegration ?? "absent"}` };
    }

    const effectId = `update-ref:${receipt.integrationAttemptId}:${merged.headSha}`;
    const effect = await adapter.prepareRefEffect({
      effectId,
      branch: receipt.integrationBranch,
      expectedBaseSha: receipt.expectedIntegrationRefSha,
      newHeadSha: merged.headSha,
      treeSha: merged.treeSha,
    });

    // A prior controller may have advanced the exact deterministic head and
    // crashed before durable observation. Reconstruct only that final effect;
    // immutable staging objects need no second write in this path.
    if (observedIntegration === merged.headSha) {
      const prepared = await hooks.prepare(effect);
      if (!prepared) return { status: "pending", reason: "final ref effect was not durably prepared" };
      if (!await hooks.observe({ effectId, observation: "applied", providerHeadSha: merged.headSha, providerResponse: "reconciled:exact-ref" })) {
        return { status: "pending", reason: "exact ref replay was observed but its durable observation fence was lost" };
      }
      return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
    }

    if (merged.synthetic) {
      const staged = await adapter.stageCandidate(merged, hooks);
      if (staged.outcome !== "applied" || staged.providerHeadSha !== merged.headSha) {
        return { status: "pending", reason: "synthetic integration object is not yet durably observable at its exact identity" };
      }
    }

    const prepared = await hooks.prepare(effect);
    if (!prepared) return { status: "pending", reason: "final ref effect was not durably prepared" };

    if (prepared.replay) {
      if (prepared.observation === "not_applied") {
        return { status: "stale", reason: "the prepared GitHub updateRefs CAS was already rejected" };
      }
      const current = await adapter.readRef(receipt.integrationBranch);
      if (current === merged.headSha) {
        if (!await hooks.observe({ effectId, observation: "applied", providerHeadSha: current, providerResponse: "reconciled:exact-ref" })) {
          return { status: "pending", reason: "exact ref replay was observed but its durable observation fence was lost" };
        }
        return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
      }
      if (current !== expectedRef) {
        return { status: "stale", reason: `prepared updateRefs CAS lost: observed ${current ?? "absent"}` };
      }
      if (hooks.reconcileOnly) {
        if (!await hooks.observe({ effectId, observation: "not_applied", providerResponse: "reconciled:exact-ref-still-at-base" })) {
          return { status: "pending", reason: "control reconciliation could not persist the exact base observation" };
        }
        return { status: "pending", reason: "prepared updateRefs was exactly observed as not applied after control fencing" };
      }
    }
    const workerImmediatelyBefore = await adapter.readRef(receipt.workerBranch);
    const integrationImmediatelyBefore = await adapter.readRef(receipt.integrationBranch);
    if (workerImmediatelyBefore !== receipt.reviewedHeadSha) {
      return { status: "stale", reason: "worker head moved after durable preparation" };
    }
    if (integrationImmediatelyBefore !== expectedRef) {
      return { status: "stale", reason: "integration ref changed after durable preparation" };
    }
    const outcome = await adapter.advanceRef({
      effectId,
      branch: receipt.integrationBranch,
      expectedBaseSha: receipt.expectedIntegrationRefSha,
      newHeadSha: merged.headSha,
    });
    if (outcome.outcome === "applied") {
      if (!await hooks.observe({
        effectId,
        observation: "applied",
        providerHeadSha: outcome.providerHeadSha ?? merged.headSha,
        providerResponse: outcome.providerResponse,
      })) return { status: "pending", reason: "GitHub applied updateRefs but the durable observation fence was lost" };
      return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
    }
    if (outcome.outcome === "not_applied") {
      if (!await hooks.observe({ effectId, observation: "not_applied", providerResponse: outcome.providerResponse })) {
        return { status: "pending", reason: "GitHub rejected updateRefs but the durable observation fence was lost" };
      }
      return { status: "stale", reason: "GitHub rejected the exact beforeOid/afterOid updateRefs compare-and-set" };
    }
    const reconciled = await adapter.readRef(receipt.integrationBranch);
    if (reconciled === merged.headSha) {
      if (!await hooks.observe({ effectId, observation: "applied", providerHeadSha: reconciled, providerResponse: outcome.providerResponse ?? "reconciled:response-loss" })) {
        return { status: "pending", reason: "response-loss reconciliation could not cross the durable observation fence" };
      }
      return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
    }
    if (!await hooks.observe({
      effectId,
      observation: "unknown",
      providerHeadSha: reconciled ?? undefined,
      providerResponse: outcome.providerResponse,
    })) return { status: "pending", reason: "ambiguous provider observation could not be persisted" };
    return { status: "pending", reason: "GitHub response was ambiguous and the exact prepared head is not observable" };
  } catch (error) {
    return { status: "pending", reason: `GitHub integration observation failed closed: ${String(error instanceof Error ? error.message : error).slice(0, 500)}` };
  }
}
