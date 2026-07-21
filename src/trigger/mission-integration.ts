export type IntegrationReceipt = Readonly<{
  workerBranch: string;
  reviewedHeadSha: string;
  reviewedHeadTreeSha: string;
  expectedIntegrationBaseSha: string;
  integrationBranch: string;
  generation: number;
}>;

export type PreparedIntegration = Readonly<{
  status: "clean" | "conflict";
  headSha?: string;
  treeSha?: string;
  reason?: string;
}>;

export type IntegrationAdapter = Readonly<{
  readRef(branch: string): Promise<string | null>;
  prepareMerge(input: {
    integrationBaseSha: string;
    workerHeadSha: string;
    workerTreeSha: string;
    generation: number;
  }): Promise<PreparedIntegration>;
  advanceRef(input: {
    branch: string;
    expectedBaseSha: string;
    newHeadSha: string;
  }): Promise<"applied" | "not_applied" | "unknown">;
}>;

export type IntegrationHooks = Readonly<{
  prepare(input: { effectId: string; expectedBaseSha: string; headSha: string; treeSha: string }): Promise<{ replay: boolean; observation?: string | null } | null>;
  observe(input: { effectId: string; observation: "applied" | "not_applied" | "unknown"; providerHeadSha?: string }): Promise<boolean>;
}>;

export type IntegrationResult =
  | { status: "integrated"; effectId: string; headSha: string; treeSha: string }
  | { status: "conflict" | "stale" | "pending"; reason: string };

/**
 * Provider writes occur only after a durable preparation. Every ambiguous
 * response is reconciled by exact ref observation before a retry. The adapter
 * must use a non-force update, making expectedBaseSha the compare-and-set
 * precondition even if another writer exists outside the controller lease.
 */
export async function integrateReviewedWorker(
  receipt: IntegrationReceipt,
  adapter: IntegrationAdapter,
  hooks: IntegrationHooks,
): Promise<IntegrationResult> {
  const workerHead = await adapter.readRef(receipt.workerBranch);
  if (workerHead !== receipt.reviewedHeadSha) {
    return { status: "stale", reason: `reviewed worker head moved: expected ${receipt.reviewedHeadSha}, observed ${workerHead ?? "missing"}` };
  }
  const observedIntegration = await adapter.readRef(receipt.integrationBranch);
  const integrationBase = receipt.expectedIntegrationBaseSha;
  const merged = await adapter.prepareMerge({
    integrationBaseSha: integrationBase,
    workerHeadSha: receipt.reviewedHeadSha,
    workerTreeSha: receipt.reviewedHeadTreeSha,
    generation: receipt.generation,
  });
  if (merged.status === "conflict" || !merged.headSha || !merged.treeSha) {
    return { status: "conflict", reason: merged.reason ?? "worker receipt conflicts with the current integration head" };
  }
  const effectId = `integrate:${receipt.integrationBranch}:${integrationBase}:${merged.headSha}`;
  const prepared = await hooks.prepare({ effectId, expectedBaseSha: integrationBase, headSha: merged.headSha, treeSha: merged.treeSha });
  if (!prepared) return { status: "pending", reason: "integration effect was not durably prepared" };

  // Crash/response-loss recovery always observes before considering another
  // write. An exact prepared head is the only adoptable external state.
  if (prepared.replay) {
    const current = observedIntegration === merged.headSha
      ? observedIntegration
      : await adapter.readRef(receipt.integrationBranch);
    if (current === merged.headSha) {
      await hooks.observe({ effectId, observation: "applied", providerHeadSha: current });
      return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
    }
    if (current && current !== integrationBase) {
      return { status: "stale", reason: `prepared integration lost compare-and-set: observed ${current}` };
    }
  }
  if (observedIntegration && observedIntegration !== integrationBase) {
    return { status: "stale", reason: `integration base advanced: expected ${integrationBase}, observed ${observedIntegration}` };
  }

  const workerImmediatelyBefore = await adapter.readRef(receipt.workerBranch);
  const integrationImmediatelyBefore = await adapter.readRef(receipt.integrationBranch);
  if (workerImmediatelyBefore !== receipt.reviewedHeadSha) {
    return { status: "stale", reason: "worker head moved after durable preparation" };
  }
  if (integrationImmediatelyBefore !== null && integrationImmediatelyBefore !== integrationBase) {
    return { status: "stale", reason: "integration base advanced after durable preparation" };
  }
  const outcome = await adapter.advanceRef({
    branch: receipt.integrationBranch,
    expectedBaseSha: integrationBase,
    newHeadSha: merged.headSha,
  });
  if (outcome === "applied") {
    await hooks.observe({ effectId, observation: "applied", providerHeadSha: merged.headSha });
    return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
  }
  if (outcome === "not_applied") {
    await hooks.observe({ effectId, observation: "not_applied" });
    return { status: "stale", reason: "provider rejected the non-force compare-and-set ref update" };
  }
  const reconciled = await adapter.readRef(receipt.integrationBranch);
  if (reconciled === merged.headSha) {
    await hooks.observe({ effectId, observation: "applied", providerHeadSha: reconciled });
    return { status: "integrated", effectId, headSha: merged.headSha, treeSha: merged.treeSha };
  }
  await hooks.observe({ effectId, observation: "unknown", providerHeadSha: reconciled ?? undefined });
  return { status: "pending", reason: "provider response was lost and the exact prepared head is not yet observable" };
}
