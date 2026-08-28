import { tasks } from "@trigger.dev/sdk/v3";
import type { NextRequest } from "next/server";

import { controlMutation, controlQuery, isSameOriginRequest } from "@/lib/control-session";
import {
  privateCreationAssetStoreConfigurationCode,
  provePrivateCreationAssetV2Capability,
} from "@/lib/private-creation-asset-store";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

type MigrationStatus = {
  state?: unknown;
  attempt?: unknown;
  snapshotComplete?: unknown;
  expectedCount?: unknown;
  verifiedCount?: unknown;
  cutoverCount?: unknown;
  activatedAt?: unknown;
  abortedAt?: unknown;
};

type CapabilityProof = {
  proofId?: unknown;
  state?: unknown;
  attempt?: unknown;
  expiresAt?: unknown;
};

type Preflight = {
  ready?: unknown;
  vercel?: unknown;
  trigger?: unknown;
  migration?: unknown;
};

function safeStatus(value: unknown) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as MigrationStatus : {};
  return {
    state: typeof row.state === "string" ? row.state : "not_started",
    attempt: Number.isSafeInteger(row.attempt) ? Number(row.attempt) : 0,
    snapshotComplete: Boolean(row.snapshotComplete),
    expectedCount: Number.isSafeInteger(row.expectedCount) ? Number(row.expectedCount) : 0,
    verifiedCount: Number.isSafeInteger(row.verifiedCount) ? Number(row.verifiedCount) : 0,
    cutoverCount: Number.isSafeInteger(row.cutoverCount) ? Number(row.cutoverCount) : 0,
    activatedAt: Number.isSafeInteger(row.activatedAt) ? Number(row.activatedAt) : undefined,
    abortedAt: Number.isSafeInteger(row.abortedAt) ? Number(row.abortedAt) : undefined,
  };
}

function safeProof(value: unknown) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as CapabilityProof : {};
  const proofId = typeof row.proofId === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(row.proofId) ? row.proofId : "";
  return {
    proofId,
    state: typeof row.state === "string" ? row.state : "missing",
    attempt: Number.isSafeInteger(row.attempt) ? Number(row.attempt) : 0,
    expiresAt: Number.isSafeInteger(row.expiresAt) ? Number(row.expiresAt) : 0,
  };
}

function safePreflight(value: unknown) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Preflight : {};
  return {
    ready: Boolean(row.ready),
    vercel: safeProof(row.vercel),
    trigger: safeProof(row.trigger),
    migration: row.migration === undefined ? undefined : safeStatus(row.migration),
  };
}

function publicPreflight(preflight: ReturnType<typeof safePreflight>) {
  // A browser needs progress states, not durable proof identifiers.
  return {
    ready: preflight.ready,
    vercel: { state: preflight.vercel.state, attempt: preflight.vercel.attempt },
    trigger: { state: preflight.trigger.state, attempt: preflight.trigger.attempt },
  };
}

async function status(credentials: ReturnType<typeof controlCredentials>) {
  return safeStatus(await controlQuery("creationAssetStoreMigration:status", credentials).catch(() => null));
}

async function beginPreflight(credentials: ReturnType<typeof controlCredentials>) {
  return safePreflight(await controlMutation("creationAssetStoreMigration:beginPreflight", credentials));
}

async function recordVercelProof(
  preflight: ReturnType<typeof safePreflight>,
  credentials: ReturnType<typeof controlCredentials>,
) {
  if (preflight.vercel.state !== "pending" || !preflight.vercel.proofId) return preflight;
  const claim = await controlMutation("creationAssetStoreMigration:claimCapabilityProof", {
    ...credentials,
    proofId: preflight.vercel.proofId,
    runtime: "vercel",
  }) as { ready?: unknown; proofId?: unknown; attempt?: unknown };
  const proofId = typeof claim?.proofId === "string" ? claim.proofId : "";
  const attempt = Number.isSafeInteger(claim?.attempt) ? Number(claim.attempt) : 0;
  if (!claim?.ready || !proofId || attempt < 1) return await beginPreflight(credentials);
  try {
    // This is a real Vercel-runtime V2 PUT, full-body GET/SHA readback, and
    // delete. The same primitive runs independently in the Trigger task.
    const verified = await provePrivateCreationAssetV2Capability(proofId);
    await controlMutation("creationAssetStoreMigration:verifyCapabilityProof", {
      ...credentials,
      proofId,
      runtime: "vercel",
      attempt,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
    });
  } catch (error) {
    await controlMutation("creationAssetStoreMigration:failCapabilityProof", {
      ...credentials,
      proofId,
      runtime: "vercel",
      attempt,
      reason: "Vercel V2 capability proof failed",
    }).catch(() => undefined);
    throw error;
  }
  return await beginPreflight(credentials);
}

async function dispatchTriggerProof(
  preflight: ReturnType<typeof safePreflight>,
  credentials: ReturnType<typeof controlCredentials>,
) {
  if (preflight.ready || preflight.trigger.state !== "pending" || !preflight.trigger.proofId || preflight.trigger.attempt < 1) {
    return preflight;
  }
  try {
    await tasks.trigger("jarvis-creation-asset-rehome-capability", { proofId: preflight.trigger.proofId }, {
      idempotencyKey: `jarvis-creation-asset-capability-${preflight.trigger.attempt}-${preflight.trigger.proofId}`,
    });
  } catch {
    // Vercel cannot attest—or mark failed on behalf of—Trigger. Leaving this
    // proof pending is fail-closed: V1 remains unfrozen and a later owner
    // action can retry dispatch while the bounded proof record is current.
    return preflight;
  }
  return await beginPreflight(credentials);
}

async function requestAction(req: NextRequest): Promise<{ action: "advance" | "abort"; reason?: string } | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return { action: "advance" };
  const body = await req.json().catch(() => null) as { action?: unknown; reason?: unknown } | null;
  if (!body || (body.action !== undefined && body.action !== "advance" && body.action !== "abort")) return null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 240) : undefined;
  return { action: body.action === "abort" ? "abort" : "advance", reason };
}

// This is a deliberately explicit owner-only control route, never an automatic
// deploy hook. It does not freeze V1 until Vercel and Trigger have separately
// persisted isolated V2 put/full-readback/delete proofs.
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin migration rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const credentials = controlCredentials(actor);
  const requested = await requestAction(req);
  if (!requested) return Response.json({ error: "invalid migration action" }, { status: 400 });

  if (requested.action === "abort") {
    try {
      const migration = safeStatus(await controlMutation("creationAssetStoreMigration:abort", {
        ...credentials,
        reason: requested.reason,
      }));
      return Response.json({ ok: true, migration });
    } catch {
      return Response.json({ error: "creation asset migration cannot be aborted after cutover" }, { status: 409 });
    }
  }

  let preflight: ReturnType<typeof safePreflight>;
  try {
    preflight = await beginPreflight(credentials);
    if (!preflight.migration) preflight = await recordVercelProof(preflight, credentials);
  } catch (error) {
    return Response.json({
      error: "isolated V2 creation storage is unavailable",
      code: privateCreationAssetStoreConfigurationCode(error),
    }, { status: 409 });
  }
  if (preflight.migration?.state === "activated") {
    return Response.json({ ok: true, active: "private-r2-v2", migration: preflight.migration });
  }
  if (!preflight.migration) {
    preflight = await dispatchTriggerProof(preflight, credentials);
    if (!preflight.ready) {
      return Response.json({ ok: true, active: false, preflight: publicPreflight(preflight), migration: await status(credentials) }, { status: 202 });
    }
  }

  try {
    await controlMutation("creationAssetStoreMigration:start", credentials);
    // One user action makes bounded snapshot progress. Repeated actions are
    // idempotent; do not put an unbounded historical scan in a Vercel route.
    for (let step = 0; step < 8; step += 1) {
      const current = await status(credentials);
      if (current.state !== "snapshotting") break;
      await controlMutation("creationAssetStoreMigration:snapshotStep", credentials);
    }
    const beforeCutover = await status(credentials);
    if (
      beforeCutover.snapshotComplete
      && beforeCutover.expectedCount === beforeCutover.verifiedCount
      && (beforeCutover.state === "cutover_ready" || beforeCutover.state === "cutting_over")
    ) {
      // The source is frozen, all exact items have independent full-byte V2
      // readback proof, and each bounded step CAS-checks the source locator.
      for (let step = 0; step < 16; step += 1) {
        const current = await status(credentials);
        if (current.state === "cutover" || current.state === "activated") break;
        await controlMutation("creationAssetStoreMigration:cutoverStep", credentials);
      }
    }
    const current = await status(credentials);
    if (
      (current.state === "cutover" || current.state === "activated")
      && current.snapshotComplete
      && current.expectedCount === current.verifiedCount
      && current.expectedCount === current.cutoverCount
    ) {
      const activated = safeStatus(await controlMutation("creationAssetStoreMigration:activate", credentials));
      if (activated.state !== "activated") throw new Error("durable activation was not confirmed");
      return Response.json({ ok: true, active: "private-r2-v2", migration: activated });
    }
    return Response.json({ ok: true, active: false, preflight: publicPreflight(preflight), migration: current }, { status: 202 });
  } catch {
    // Details stay in the durable migration row and server logs; the browser
    // gets no storage locator, bucket, vault, or provider diagnostic.
    return Response.json({ error: "creation asset migration could not advance" }, { status: 409 });
  }
}

export async function GET(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor || !isOwnerActor(actor)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json({ migration: await status(controlCredentials(actor)) });
}
