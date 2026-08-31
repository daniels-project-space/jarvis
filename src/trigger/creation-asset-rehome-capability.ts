import { task } from "@trigger.dev/sdk/v3";

import { provePrivateCreationAssetV2Capability } from "../lib/private-creation-asset-store";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

type CapabilityClaim =
  | { ready: true; proofId: string; attempt: number }
  | { ready: false; inactive?: boolean; missing?: boolean };

async function convexCall(kind: "mutation" | "query", path: string, args: Record<string, unknown>) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const body = await response.json().catch(() => null) as { status?: string; value?: unknown; errorMessage?: string } | null;
  if (!response.ok || !body || body.status === "error") {
    throw new Error(`Convex ${kind} ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 240)}`);
  }
  return body.value;
}

function cleanProofId(value: unknown): string {
  const proofId = typeof value === "string" ? value.trim() : "";
  // A capability task receives only this opaque durable identifier. The V2
  // probe locator is derived inside the server-only store primitive.
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(proofId)) {
    throw new Error("creation asset capability proof identity is invalid");
  }
  return proofId;
}

export async function proveCreationAssetV2Capability(
  proofIdInput: unknown,
  dependencies: {
    call?: typeof convexCall;
    prove?: typeof provePrivateCreationAssetV2Capability;
  } = {},
) {
  const proofId = cleanProofId(proofIdInput);
  const call = dependencies.call ?? convexCall;
  const prove = dependencies.prove ?? provePrivateCreationAssetV2Capability;
  let claim: CapabilityClaim | undefined;
  try {
    claim = await call("mutation", "creationAssetStoreMigration:claimCapabilityProof", {
      proofId,
      runtime: "trigger",
    }) as CapabilityClaim;
    if (!claim.ready) return { proofId, skipped: true, ...claim };

    // This executes in the Trigger runtime with that runtime's own selector,
    // vault access, and object-store client: V2 PUT, full-byte GET/SHA, then
    // probe deletion. There is intentionally no V1 branch or locator input.
    const verified = await prove(claim.proofId);
    await call("mutation", "creationAssetStoreMigration:verifyCapabilityProof", {
      proofId: claim.proofId,
      runtime: "trigger",
      attempt: claim.attempt,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
    });
    return { proofId: claim.proofId, verified: true, ...verified };
  } catch (error) {
    if (claim?.ready) {
      // Do not send object-store/vault diagnostics through the durable control
      // plane. A fresh explicit preflight creates the next audited attempt.
      await call("mutation", "creationAssetStoreMigration:failCapabilityProof", {
        proofId: claim.proofId,
        runtime: "trigger",
        attempt: claim.attempt,
        reason: "Trigger V2 capability proof failed",
      }).catch(() => undefined);
    }
    throw error;
  }
}

// The payload deliberately contains an opaque proof ID only; it cannot select
// a bucket, vault, source key, destination key, or storage version.
export const creationAssetRehomeCapability = task({
  id: "jarvis-creation-asset-rehome-capability",
  queue: { name: "jarvis-private-creation-asset-capability", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (payload: { proofId: string }) => await proveCreationAssetV2Capability(payload.proofId),
});
