import "server-only";

import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";
import type { PrivateCreationAsset } from "./creation-assets";
import { privateCreationObjectKey } from "./private-r2";

type CreationReceipt = string;
type BeforeR2Write = () => Promise<void>;

export type PrivateCreationAssetLifecycle = Readonly<{
  reserve: (assetR2Key: string, writerEpoch: string) => Promise<unknown>;
  renewForWrite: (assetR2Key: string, writerEpoch: string) => Promise<unknown>;
  markWritten: (assetR2Key: string, writerEpoch: string) => Promise<unknown>;
  abandon: (assetR2Key: string, writerEpoch: string) => Promise<unknown>;
  complete: (assetR2Key: string) => Promise<unknown>;
  findCreationByAssetR2Key: (assetR2Key: string) => Promise<unknown>;
}>;

export type PrivateCreationAssetWriteOptions = Readonly<{
  // `beforeR2Write` must be invoked by the storage primitive directly before
  // each R2 PUT. Fetching source bytes or rendering may happen earlier without
  // consuming the bounded creation-commit lease.
  writeAsset: (assetId: string, beforeR2Write: BeforeR2Write) => Promise<PrivateCreationAsset>;
  persistCreation: (asset: PrivateCreationAsset, writerEpoch: string) => Promise<unknown>;
  lifecycle: PrivateCreationAssetLifecycle;
}>;

export type PrivateCreationAssetWriteResult =
  | Readonly<{ ok: true; asset: PrivateCreationAsset; creationId: CreationReceipt; recovered: boolean }>
  | Readonly<{ ok: false; stage: "reservation" | "asset_write" | "creation_unverified"; error: unknown }>;

function creationReceipt(value: unknown): CreationReceipt | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function cleanupIdempotencyKey(assetR2Key: string): string {
  const assetId = assetR2Key.split("/")[3] ?? "unknown";
  return `jarvis-creation-asset-cleanup-${assetId}`;
}

export async function schedulePrivateCreationAssetCleanup(assetR2Key: string): Promise<void> {
  // Trigger is an accelerator, not the source of truth. A lost enqueue ack
  // leaves the durable Convex intent for periodic reconciliation.
  await tasks.trigger(
    "jarvis-creation-asset-cleanup",
    { assetR2Key },
    { idempotencyKey: cleanupIdempotencyKey(assetR2Key) },
  );
}

async function lookupCreation(
  lifecycle: PrivateCreationAssetLifecycle,
  assetR2Key: string,
): Promise<CreationReceipt | null> {
  try {
    return creationReceipt(await lifecycle.findCreationByAssetR2Key(assetR2Key));
  } catch {
    return null;
  }
}

async function abandonOrRecover(
  lifecycle: PrivateCreationAssetLifecycle,
  assetR2Key: string,
  writerEpoch: string,
): Promise<CreationReceipt | null> {
  // A create commit may land just after the last lookup. This mutation either
  // observes that canonical row or switches the matching writer epoch to
  // cleanup ownership before any late create can insert a broken reference.
  await lifecycle.abandon(assetR2Key, writerEpoch).catch(() => undefined);
  const recovered = await lookupCreation(lifecycle, assetR2Key);
  if (recovered) return recovered;
  await schedulePrivateCreationAssetCleanup(assetR2Key).catch(() => undefined);
  return null;
}

async function persistOrRecover(
  persistCreation: (asset: PrivateCreationAsset, writerEpoch: string) => Promise<unknown>,
  lifecycle: PrivateCreationAssetLifecycle,
  asset: PrivateCreationAsset,
  writerEpoch: string,
): Promise<{ creationId: CreationReceipt; recovered: boolean } | null> {
  // Repeating the same create is safe only because `creations:create` treats
  // exact authenticated owner + opaque R2 key as its idempotency identity.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const direct = creationReceipt(await persistCreation(asset, writerEpoch));
      if (direct) return { creationId: direct, recovered: false };
    } catch {
      // The remote mutation may already have committed. Canonical lookup
      // distinguishes that from a real rejection without touching R2.
    }
    const recovered = await lookupCreation(lifecycle, asset.key);
    if (recovered) return { creationId: recovered, recovered: true };
  }
  const recovered = await lookupCreation(lifecycle, asset.key);
  return recovered ? { creationId: recovered, recovered: true } : null;
}

// The one legal bridge from private R2 into a creations-library row. Every
// producer reserves an opaque key, renews immediately at the R2 boundary, and
// delegates every ambiguous outcome to the same durable recovery protocol.
export async function writePrivateCreationAssetWithRecord(
  options: PrivateCreationAssetWriteOptions,
): Promise<PrivateCreationAssetWriteResult> {
  const assetId = randomUUID();
  const writerEpoch = randomUUID();
  const expectedAssetR2Key = privateCreationObjectKey(assetId, "asset");
  try {
    await options.lifecycle.reserve(expectedAssetR2Key, writerEpoch);
  } catch (error) {
    await abandonOrRecover(options.lifecycle, expectedAssetR2Key, writerEpoch);
    return { ok: false, stage: "reservation", error };
  }

  let renewedForR2 = false;
  const beforeR2Write: BeforeR2Write = async () => {
    await options.lifecycle.renewForWrite(expectedAssetR2Key, writerEpoch);
    renewedForR2 = true;
  };

  let asset: PrivateCreationAsset;
  try {
    asset = await options.writeAsset(assetId, beforeR2Write);
    if (!renewedForR2) {
      throw new Error("private creation writer bypassed its R2 lease renewal");
    }
    if (asset.key !== expectedAssetR2Key) {
      throw new Error("private creation asset writer returned an unexpected object identity");
    }
  } catch (error) {
    await abandonOrRecover(options.lifecycle, expectedAssetR2Key, writerEpoch);
    return { ok: false, stage: "asset_write", error };
  }

  // A lost markWritten response is safe to continue through: create checks
  // the exact live epoch, while a cleanup-owned key rejects and remains in the
  // nonterminal reaper. Never turn that ambiguity into a direct R2 delete.
  await options.lifecycle.markWritten(asset.key, writerEpoch).catch(() => undefined);
  const persisted = await persistOrRecover(options.persistCreation, options.lifecycle, asset, writerEpoch);
  if (!persisted) {
    const recovered = await abandonOrRecover(options.lifecycle, asset.key, writerEpoch);
    if (recovered) {
      await options.lifecycle.complete(asset.key).catch(() => undefined);
      return { ok: true, asset, creationId: recovered, recovered: true };
    }
    return {
      ok: false,
      stage: "creation_unverified",
      error: new Error("private creation persistence could not be verified"),
    };
  }
  // Normally create has consumed the intent atomically. This remains safe
  // compatibility cleanup for a mixed Convex rollout.
  await options.lifecycle.complete(asset.key).catch(() => undefined);
  return { ok: true, asset, creationId: persisted.creationId, recovered: persisted.recovered };
}
