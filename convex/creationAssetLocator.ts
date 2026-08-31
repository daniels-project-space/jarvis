// Pure Convex-side locator rules. Keep this separate from the server-only R2
// client so mutations can validate storage identity without gaining storage
// credentials or a path to arbitrary object-store operations.

export const CREATION_ASSET_STORE_V1 = "private-r2-v1" as const;
export const CREATION_ASSET_STORE_V2 = "private-r2-v2" as const;
export type CreationAssetStore = typeof CREATION_ASSET_STORE_V1 | typeof CREATION_ASSET_STORE_V2;

export type CreationAssetLocator = Readonly<{
  assetStore: CreationAssetStore;
  assetLocator: string;
}>;

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const V1_LOCATOR = new RegExp(`^owners/daniel/creations/${UUID_SOURCE}/(?:asset|thumb)$`, "i");
const V2_LIVE_LOCATOR = new RegExp(`^owners/daniel/creation-assets-v2/live/${UUID_SOURCE}/(?:asset|thumb)$`, "i");
// Both the attempt and per-claim generation are required. A lease revokes
// Convex authority, but cannot cancel an already accepted object-store PUT;
// a delayed worker can therefore write only its retired generation, never the
// destination selected by a later retry.
const V2_MIGRATION_LOCATOR = /^owners\/daniel\/creation-assets-v2\/migration\/[1-9][0-9]{0,8}\/[A-Za-z0-9_-]{8,160}\/generation\/[1-9][0-9]{0,8}\/(?:asset|thumb)$/;
const V2_PROBE_LOCATOR = /^owners\/daniel\/creation-assets-v2\/probe\/[A-Za-z0-9_-]{8,160}\/capability$/;

export function isCreationAssetStore(value: unknown): value is CreationAssetStore {
  return value === CREATION_ASSET_STORE_V1 || value === CREATION_ASSET_STORE_V2;
}

export function isCreationAssetLocator(value: unknown): value is CreationAssetLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { assetStore?: unknown; assetLocator?: unknown };
  if (!isCreationAssetStore(record.assetStore) || typeof record.assetLocator !== "string") return false;
  return record.assetStore === CREATION_ASSET_STORE_V1
    ? V1_LOCATOR.test(record.assetLocator)
    : V2_LIVE_LOCATOR.test(record.assetLocator) || V2_MIGRATION_LOCATOR.test(record.assetLocator) || V2_PROBE_LOCATOR.test(record.assetLocator);
}

// Only ordinary live identities may enter user-facing creation/cleanup
// mutations. Migration and capability-probe namespaces are server-derived
// internals; rows still accept them through isCreationAssetLocator for reads.
function isCreationAssetInputLocator(value: unknown): value is CreationAssetLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { assetStore?: unknown; assetLocator?: unknown };
  if (!isCreationAssetStore(record.assetStore) || typeof record.assetLocator !== "string") return false;
  return record.assetStore === CREATION_ASSET_STORE_V1
    ? V1_LOCATOR.test(record.assetLocator)
    : V2_LIVE_LOCATOR.test(record.assetLocator);
}

export function isPrivateCreationAssetKey(value: string | undefined): value is string {
  return typeof value === "string" && (V1_LOCATOR.test(value) || V2_LIVE_LOCATOR.test(value) || V2_MIGRATION_LOCATOR.test(value));
}

export function creationAssetLocatorFromRow(row: {
  assetStore?: unknown;
  assetLocator?: unknown;
  assetR2Key?: unknown;
}): CreationAssetLocator | null {
  if (row.assetStore !== undefined || row.assetLocator !== undefined) {
    const explicit = { assetStore: row.assetStore, assetLocator: row.assetLocator };
    return isCreationAssetLocator(explicit) ? explicit : null;
  }
  return typeof row.assetR2Key === "string" && V1_LOCATOR.test(row.assetR2Key)
    ? { assetStore: CREATION_ASSET_STORE_V1, assetLocator: row.assetR2Key }
    : null;
}

export function creationAssetLocatorFromInput(input: {
  assetStore?: unknown;
  assetLocator?: unknown;
  assetR2Key?: unknown;
}): CreationAssetLocator | null {
  const explicit = input.assetStore !== undefined || input.assetLocator !== undefined;
  if (explicit) {
    const locator = { assetStore: input.assetStore, assetLocator: input.assetLocator };
    if (!isCreationAssetLocator(locator)) return null;
    // assetR2Key is a staged compatibility mirror, never an alternate path.
    if (input.assetR2Key !== undefined && input.assetR2Key !== locator.assetLocator) return null;
    return locator;
  }
  return typeof input.assetR2Key === "string" && V1_LOCATOR.test(input.assetR2Key)
    ? { assetStore: CREATION_ASSET_STORE_V1, assetLocator: input.assetR2Key }
    : null;
}

// New producer writes are stricter than internal reads/cleanup lookups.
// Migration/probe locators may be read from durable rows, but callers cannot
// choose either reserved namespace for a new upload or reservation.
export function creationAssetLocatorFromWriteInput(input: {
  assetStore?: unknown;
  assetLocator?: unknown;
  assetR2Key?: unknown;
}): CreationAssetLocator | null {
  const explicit = input.assetStore !== undefined || input.assetLocator !== undefined;
  if (explicit) {
    const locator = { assetStore: input.assetStore, assetLocator: input.assetLocator };
    if (!isCreationAssetInputLocator(locator)) return null;
    if (input.assetR2Key !== undefined && input.assetR2Key !== locator.assetLocator) return null;
    return locator;
  }
  return typeof input.assetR2Key === "string" && V1_LOCATOR.test(input.assetR2Key)
    ? { assetStore: CREATION_ASSET_STORE_V1, assetLocator: input.assetR2Key }
    : null;
}

export function creationAssetLocatorForMigration(
  creationId: string,
  attempt: number,
  generation: number,
): CreationAssetLocator {
  const id = String(creationId).trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) throw new Error("invalid creation migration identity");
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 999_999_999) {
    throw new Error("invalid creation migration attempt");
  }
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 999_999_999) {
    throw new Error("invalid creation migration generation");
  }
  return {
    assetStore: CREATION_ASSET_STORE_V2,
    assetLocator: `owners/daniel/creation-assets-v2/migration/${attempt}/${id}/generation/${generation}/asset`,
  };
}

// Capability probes use a V2-only namespace that cannot collide with either
// live creation assets or migration copies. The id is a server-issued Convex
// document id, never a user-provided path segment.
export function creationAssetLocatorForCapabilityProbe(proofId: string): CreationAssetLocator {
  const id = String(proofId).trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) throw new Error("invalid creation asset capability proof identity");
  return {
    assetStore: CREATION_ASSET_STORE_V2,
    assetLocator: `owners/daniel/creation-assets-v2/probe/${id}/capability`,
  };
}
