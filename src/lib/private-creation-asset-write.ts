import "server-only";

import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";
import type { PrivateCreationAsset } from "./creation-assets";
import {
  activePrivateCreationAssetStore,
  privateCreationAssetLocatorForWrite,
  type PrivateCreationAssetLocator,
} from "./private-creation-asset-store";

type CreationReceipt = string;
type BeforeR2Write = () => Promise<void>;
type LegacyPrivateCreationAsset = Readonly<{
  key?: string;
  contentType?: string;
  assetStore?: PrivateCreationAssetLocator["assetStore"];
  assetLocator?: string;
}>;

export type PrivateCreationAssetLifecycle = Readonly<{
  reserve: (asset: PrivateCreationAssetLocator, writerEpoch: string) => Promise<unknown>;
  renewForWrite: (asset: PrivateCreationAssetLocator, writerEpoch: string) => Promise<unknown>;
  markWritten: (asset: PrivateCreationAssetLocator, writerEpoch: string) => Promise<unknown>;
  abandon: (asset: PrivateCreationAssetLocator, writerEpoch: string) => Promise<unknown>;
  complete: (asset: PrivateCreationAssetLocator) => Promise<unknown>;
  findCreationByAssetLocator: (asset: PrivateCreationAssetLocator) => Promise<unknown>;
}>;

export type PrivateCreationAssetWriteOptions = Readonly<{
  // `beforeR2Write` must be invoked by the storage primitive directly before
  // each R2 PUT. Fetching source bytes or rendering may happen earlier without
  // consuming the bounded creation-commit lease.
  writeAsset: (assetId: string, beforeR2Write: BeforeR2Write) => Promise<PrivateCreationAsset | LegacyPrivateCreationAsset>;
  persistCreation: (asset: PrivateCreationAsset, writerEpoch: string) => Promise<unknown>;
  lifecycle: PrivateCreationAssetLifecycle;
}>;

export type PrivateCreationAssetWriteResult =
  | Readonly<{ ok: true; asset: PrivateCreationAsset; creationId: CreationReceipt; recovered: boolean }>
  | Readonly<{ ok: false; stage: "reservation" | "asset_write" | "creation_unverified"; error: unknown }>;

function creationReceipt(value: unknown): CreationReceipt | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeWrittenAsset(
  asset: PrivateCreationAsset | LegacyPrivateCreationAsset,
  expected: PrivateCreationAssetLocator,
): PrivateCreationAsset {
  // The V1 shape was `{ key, contentType }`. Keep a short compatibility
  // bridge for an already-running producer, but normalize it before any
  // lifecycle/persistence call; V2 has no such fallback because its explicit
  // store is required by the expected reserved identity.
  const candidate = asset as LegacyPrivateCreationAsset;
  const assetStore = candidate.assetStore ?? expected.assetStore;
  const assetLocator = candidate.assetLocator ?? candidate.key ?? "";
  return {
    ...candidate,
    key: candidate.key ?? assetLocator,
    assetStore,
    assetLocator,
    contentType: candidate.contentType ?? "application/octet-stream",
  };
}

function cleanupIdempotencyKey(asset: PrivateCreationAssetLocator): string {
  const parts = asset.assetLocator.split("/");
  const assetId = parts[parts.length - 2] ?? "unknown";
  return `jarvis-creation-asset-cleanup-${asset.assetStore}-${assetId}`;
}

export async function schedulePrivateCreationAssetCleanup(asset: PrivateCreationAssetLocator): Promise<void> {
  // Trigger is an accelerator, not the source of truth. A lost enqueue ack
  // leaves the durable Convex intent for periodic reconciliation.
  await tasks.trigger(
    "jarvis-creation-asset-cleanup",
    { assetR2Key: asset.assetLocator, assetStore: asset.assetStore, assetLocator: asset.assetLocator },
    { idempotencyKey: cleanupIdempotencyKey(asset) },
  );
}

async function lookupCreation(
  lifecycle: PrivateCreationAssetLifecycle,
  asset: PrivateCreationAssetLocator,
): Promise<CreationReceipt | null> {
  try {
    return creationReceipt(await lifecycle.findCreationByAssetLocator(asset));
  } catch {
    return null;
  }
}

async function abandonOrRecover(
  lifecycle: PrivateCreationAssetLifecycle,
  asset: PrivateCreationAssetLocator,
  writerEpoch: string,
): Promise<CreationReceipt | null> {
  // A create commit may land just after the last lookup. This mutation either
  // observes that canonical row or switches the matching writer epoch to
  // cleanup ownership before any late create can insert a broken reference.
  await lifecycle.abandon(asset, writerEpoch).catch(() => undefined);
  const recovered = await lookupCreation(lifecycle, asset);
  if (recovered) return recovered;
  await schedulePrivateCreationAssetCleanup(asset).catch(() => undefined);
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
    const recovered = await lookupCreation(lifecycle, asset);
    if (recovered) return { creationId: recovered, recovered: true };
  }
  const recovered = await lookupCreation(lifecycle, asset);
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
  const expectedAsset = privateCreationAssetLocatorForWrite(activePrivateCreationAssetStore(), assetId, "asset");
  try {
    await options.lifecycle.reserve(expectedAsset, writerEpoch);
  } catch (error) {
    await abandonOrRecover(options.lifecycle, expectedAsset, writerEpoch);
    return { ok: false, stage: "reservation", error };
  }

  let renewedForR2 = false;
  const beforeR2Write: BeforeR2Write = async () => {
    await options.lifecycle.renewForWrite(expectedAsset, writerEpoch);
    renewedForR2 = true;
  };

  let asset: PrivateCreationAsset;
  try {
    asset = normalizeWrittenAsset(await options.writeAsset(assetId, beforeR2Write), expectedAsset);
    if (!renewedForR2) {
      throw new Error("private creation writer bypassed its R2 lease renewal");
    }
    if (asset.assetStore !== expectedAsset.assetStore || asset.assetLocator !== expectedAsset.assetLocator) {
      throw new Error("private creation asset writer returned an unexpected object identity");
    }
  } catch (error) {
    await abandonOrRecover(options.lifecycle, expectedAsset, writerEpoch);
    return { ok: false, stage: "asset_write", error };
  }

  // A lost markWritten response is safe to continue through: create checks
  // the exact live epoch, while a cleanup-owned key rejects and remains in the
  // nonterminal reaper. Never turn that ambiguity into a direct R2 delete.
  await options.lifecycle.markWritten(expectedAsset, writerEpoch).catch(() => undefined);
  const persisted = await persistOrRecover(options.persistCreation, options.lifecycle, asset, writerEpoch);
  if (!persisted) {
    const recovered = await abandonOrRecover(options.lifecycle, expectedAsset, writerEpoch);
    if (recovered) {
      await options.lifecycle.complete(expectedAsset).catch(() => undefined);
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
  await options.lifecycle.complete(expectedAsset).catch(() => undefined);
  return { ok: true, asset, creationId: persisted.creationId, recovered: persisted.recovered };
}
