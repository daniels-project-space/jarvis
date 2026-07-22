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
  preparedEffectId?: string;
  preparedIntegrationHeadSha?: string;
  preparedIntegrationTreeSha?: string;
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
  attestDeploymentFence(candidate: { headSha: string; treeSha: string }): Promise<void>;
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
    const expectedRef = expectedObservedRef(receipt.expectedIntegrationRefSha);
    const workerHead = await adapter.readRef(receipt.workerBranch);
    if (workerHead !== receipt.reviewedHeadSha) {
      if (receipt.preparedEffectId && receipt.preparedIntegrationHeadSha && receipt.preparedIntegrationTreeSha) {
        const current = await adapter.readRef(receipt.integrationBranch);
        await adapter.attestDeploymentFence({
          headSha: receipt.preparedIntegrationHeadSha,
          treeSha: receipt.preparedIntegrationTreeSha,
        });
        const effect = await adapter.prepareRefEffect({
          effectId: receipt.preparedEffectId,
          branch: receipt.integrationBranch,
          expectedBaseSha: receipt.expectedIntegrationRefSha,
          newHeadSha: receipt.preparedIntegrationHeadSha,
          treeSha: receipt.preparedIntegrationTreeSha,
        });
        const prepared = await hooks.prepare(effect);
        if (!prepared) return { status: "pending", reason: "prepared final ref effect could not be reloaded after the worker moved" };
        if (prepared.observation === "applied" || current === receipt.preparedIntegrationHeadSha) {
          if (prepared.observation !== "applied" && !await hooks.observe({
            effectId: receipt.preparedEffectId, observation: "applied",
            providerHeadSha: receipt.preparedIntegrationHeadSha, providerResponse: "reconciled:exact-ref-after-worker-move",
          })) return { status: "pending", reason: "applied ref observation after worker movement could not be persisted" };
          return {
            status: "integrated", effectId: receipt.preparedEffectId,
            headSha: receipt.preparedIntegrationHeadSha, treeSha: receipt.preparedIntegrationTreeSha,
          };
        }
        if (prepared.observation === "not_applied" || current === expectedRef || !prepared.replay) {
          if (prepared.observation !== "not_applied" && !await hooks.observe({
            effectId: receipt.preparedEffectId, observation: "not_applied",
            providerResponse: "preflight:worker-ref-moved-before-provider-call",
          })) return { status: "pending", reason: "worker-move non-application observation could not be persisted" };
          return { status: "stale", reason: `reviewed worker head moved after final preparation: observed ${workerHead ?? "missing"}` };
        }
        if (!await hooks.observe({
          effectId: receipt.preparedEffectId, observation: "unknown", providerHeadSha: current ?? undefined,
          providerResponse: "reconciled:prepared-ref-at-third-head-after-worker-move",
        })) return { status: "pending", reason: "ambiguous worker-move replay observation could not be persisted" };
        return { status: "pending", reason: "worker moved and the prepared updateRefs replay is ambiguous at a third head" };
      }
      return { status: "stale", reason: `reviewed worker head moved: expected ${receipt.reviewedHeadSha}, observed ${workerHead ?? "missing"}` };
    }
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
    await adapter.attestDeploymentFence({ headSha: merged.headSha, treeSha: merged.treeSha });

    const effectId = `update-ref:${receipt.integrationAttemptId}:${merged.headSha}`;
    const effect = await adapter.prepareRefEffect({
      effectId,
      branch: receipt.integrationBranch,
      expectedBaseSha: receipt.expectedIntegrationRefSha,
      newHeadSha: merged.headSha,
      treeSha: merged.treeSha,
    });

    // A moved ref is terminally stale only when this invocation first prepares
    // the exact CAS and therefore proves it was never called. A replay may have
    // applied and then moved again, so a third head is ambiguous provider truth.
    if (observedIntegration !== expectedRef && observedIntegration !== merged.headSha) {
      const prepared = await hooks.prepare(effect);
      if (!prepared) return { status: "pending", reason: "final ref effect was not durably prepared" };
      if (prepared.replay) {
        if (prepared.observation === "applied") {
          if (merged.synthetic) {
            const staged = await adapter.stageCandidate(merged, { ...hooks, reconcileOnly: true });
            if (staged.outcome !== "applied" || staged.providerHeadSha !== merged.headSha) {
              return { status: "pending", reason: "applied final ref has incomplete synthetic object observations" };
            }
          }
          return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
        }
        if (prepared.observation === "not_applied") {
          return { status: "stale", reason: `prepared updateRefs CAS was proven not applied before the ref moved to ${observedIntegration ?? "absent"}` };
        }
        if (!await hooks.observe({
          effectId, observation: "unknown", providerHeadSha: observedIntegration ?? undefined,
          providerResponse: "reconciled:prepared-ref-at-third-head",
        })) return { status: "pending", reason: "ambiguous replay observation could not be persisted" };
        return { status: "pending", reason: `prepared updateRefs CAS is ambiguous at ${observedIntegration ?? "absent"}` };
      }
      if (!await hooks.observe({
        effectId, observation: "not_applied", providerHeadSha: observedIntegration ?? undefined,
        providerResponse: "preflight:integration-ref-moved-before-provider-call",
      })) return { status: "pending", reason: "pre-call non-application observation could not be persisted" };
      return { status: "stale", reason: `integration ref changed before updateRefs: expected ${expectedRef ?? "absent"}, observed ${observedIntegration ?? "absent"}` };
    }

    // A prior controller may have advanced the exact deterministic head and
    // crashed before one or more durable staging observations. The ref proves
    // the immutable object graph exists, but it does not prove that every cold
    // prepare row crossed its durable observe fence. Replay the normal staging
    // boundary read-only before the final ref observation; reconcileOnly keeps
    // this path incapable of issuing a duplicate provider write.
    if (observedIntegration === merged.headSha) {
      if (merged.synthetic) {
        const staged = await adapter.stageCandidate(merged, { ...hooks, reconcileOnly: true });
        if (staged.outcome !== "applied" || staged.providerHeadSha !== merged.headSha) {
          return { status: "pending", reason: "exact final ref is applied but its synthetic object observations are not fully durable" };
        }
      }
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
      if (prepared.observation === "applied") {
        return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
      }
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
        if (!await hooks.observe({
          effectId, observation: "unknown", providerHeadSha: current ?? undefined,
          providerResponse: "reconciled:prepared-ref-at-third-head",
        })) return { status: "pending", reason: "ambiguous replay observation could not be persisted" };
        return { status: "pending", reason: `prepared updateRefs CAS is ambiguous at ${current ?? "absent"}` };
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
    if (integrationImmediatelyBefore === merged.headSha) {
      if (!await hooks.observe({
        effectId, observation: "applied", providerHeadSha: merged.headSha,
        providerResponse: "reconciled:exact-ref-before-provider-call",
      })) return { status: "pending", reason: "pre-call applied observation could not be persisted" };
      return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
    }
    if (integrationImmediatelyBefore !== expectedRef && prepared.replay) {
      if (!await hooks.observe({
        effectId, observation: "unknown", providerHeadSha: integrationImmediatelyBefore ?? undefined,
        providerResponse: "reconciled:prepared-ref-moved-before-retry",
      })) return { status: "pending", reason: "ambiguous pre-retry observation could not be persisted" };
      return { status: "pending", reason: "prepared updateRefs replay became ambiguous before the provider call" };
    }
    if (workerImmediatelyBefore !== receipt.reviewedHeadSha) {
      if (!await hooks.observe({
        effectId, observation: "not_applied", providerResponse: "preflight:worker-ref-moved-before-provider-call",
      })) return { status: "pending", reason: "worker-move non-application observation could not be persisted" };
      return { status: "stale", reason: "worker head moved after durable preparation" };
    }
    if (integrationImmediatelyBefore !== expectedRef) {
      if (!await hooks.observe({
        effectId, observation: "not_applied", providerHeadSha: integrationImmediatelyBefore ?? undefined,
        providerResponse: "preflight:integration-ref-moved-before-provider-call",
      })) return { status: "pending", reason: "ref-move non-application observation could not be persisted" };
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
