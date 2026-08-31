import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "creation-asset-store-migration-test-worker";
const OWNER_HASH = "a".repeat(64);
const migrationApi = api as any;

function v1Key(assetId: string): string {
  return `owners/daniel/creations/${assetId}/asset`;
}

function v2LiveKey(assetId: string): string {
  return `owners/daniel/creation-assets-v2/live/${assetId}/asset`;
}

async function seedV1Creation(t: ReturnType<typeof convexTest>, assetId: string) {
  const key = v1Key(assetId);
  const id = await t.run(async (ctx) => await ctx.db.insert("creations", {
    kind: "image",
    title: "Migration source",
    assetR2Key: key,
    assetContentType: "image/png",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  return { id, key };
}

async function completeSnapshot(t: ReturnType<typeof convexTest>) {
  const owner = await ownerCredentials(t);
  for (let step = 0; step < 8; step += 1) {
    const current = await t.query(migrationApi.creationAssetStoreMigration.status, owner);
    if (current?.state !== "snapshotting") return current;
    await t.mutation(migrationApi.creationAssetStoreMigration.snapshotStep, owner);
  }
  return await t.query(migrationApi.creationAssetStoreMigration.status, owner);
}

async function ownerCredentials(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const db: any = ctx.db;
    const existing = await db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", OWNER_HASH))
      .first();
    if (!existing) {
      const now = Date.now();
      await db.insert("adminSessions", {
        tokenHash: OWNER_HASH,
        enrolledAt: now,
        createdAt: now,
        expiresAt: now + 60 * 60_000,
      });
    }
  });
  return { authTokenHash: OWNER_HASH };
}

async function proveV2Preflight(t: ReturnType<typeof convexTest>, expectedAttempt = 1) {
  const owner = await ownerCredentials(t);
  const pending = await t.mutation(migrationApi.creationAssetStoreMigration.beginPreflight, owner) as any;
  expect(pending).toMatchObject({
    ready: false,
    vercel: { state: "pending", attempt: expectedAttempt, proofId: expect.any(String) },
    trigger: { state: "pending", attempt: expectedAttempt, proofId: expect.any(String) },
  });
  // A worker gets an opaque proof id only, never a bucket, vault selector, or
  // object locator to choose for itself.
  const triggerClaim = await t.mutation(migrationApi.creationAssetStoreMigration.claimCapabilityProof, {
    proofId: pending.trigger.proofId,
    runtime: "trigger",
    workerToken: WORKER,
  });
  expect(triggerClaim).toMatchObject({ ready: true, proofId: pending.trigger.proofId, attempt: expectedAttempt });
  expect(JSON.stringify(triggerClaim)).not.toContain("assetLocator");

  // An owner/Vercel control credential cannot pretend to be the Trigger
  // runtime. The durable pair is authority-bound as well as state-bound.
  await expect(t.mutation(migrationApi.creationAssetStoreMigration.verifyCapabilityProof, {
    proofId: pending.trigger.proofId,
    runtime: "trigger",
    attempt: pending.trigger.attempt,
    sha256: "d".repeat(64),
    sizeBytes: 3,
    ...owner,
  })).rejects.toThrow("Unauthorized worker capability");
  await expect(t.mutation(migrationApi.creationAssetStoreMigration.verifyCapabilityProof, {
    proofId: pending.vercel.proofId,
    runtime: "vercel",
    attempt: pending.vercel.attempt,
    sha256: "c".repeat(64),
    sizeBytes: 3,
    workerToken: WORKER,
  })).rejects.toThrow("Authentication required");

  for (const runtime of ["vercel", "trigger"] as const) {
    const proof = pending[runtime];
    await t.mutation(migrationApi.creationAssetStoreMigration.verifyCapabilityProof, {
      proofId: proof.proofId,
      runtime,
      attempt: proof.attempt,
      sha256: runtime === "vercel" ? "c".repeat(64) : "d".repeat(64),
      sizeBytes: 3,
      ...(runtime === "vercel" ? owner : { workerToken: WORKER }),
    });
  }
  await expect(t.mutation(migrationApi.creationAssetStoreMigration.beginPreflight, owner))
    .resolves.toMatchObject({ ready: true, vercel: { state: "verified", attempt: expectedAttempt }, trigger: { state: "verified", attempt: expectedAttempt } });
}

async function startWithProvenV2(t: ReturnType<typeof convexTest>) {
  await proveV2Preflight(t);
  return await t.mutation(migrationApi.creationAssetStoreMigration.start, await ownerCredentials(t));
}

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

describe("creation asset store migration", () => {
  it("rejects shared worker capability for every owner lifecycle control", async () => {
    const t = convexTest(schema, modules);
    for (const control of [
      migrationApi.creationAssetStoreMigration.beginPreflight,
      migrationApi.creationAssetStoreMigration.start,
      migrationApi.creationAssetStoreMigration.abort,
      migrationApi.creationAssetStoreMigration.snapshotStep,
      migrationApi.creationAssetStoreMigration.cutoverStep,
      migrationApi.creationAssetStoreMigration.activate,
    ]) {
      await expect(t.mutation(control, { workerToken: WORKER })).rejects.toThrow("Authentication required");
    }
    await expect(t.query(migrationApi.creationAssetStoreMigration.status, { workerToken: WORKER }))
      .rejects.toThrow("Authentication required");
    const { id } = await seedV1Creation(t, "1d1c4ea4-0000-4fa2-9b00-000000000001");
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.issueDestinationDeletionTicket, {
      creationId: id,
      workerToken: WORKER,
    })).rejects.toThrow("Authentication required");
  });

  it("binds proof failure to the runtime that owns that proof", async () => {
    const t = convexTest(schema, modules);
    const owner = await ownerCredentials(t);
    const pending = await t.mutation(migrationApi.creationAssetStoreMigration.beginPreflight, owner) as any;

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.failCapabilityProof, {
      proofId: pending.trigger.proofId,
      runtime: "trigger",
      attempt: pending.trigger.attempt,
      ...owner,
    })).rejects.toThrow("Unauthorized worker capability");
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.failCapabilityProof, {
      proofId: pending.vercel.proofId,
      runtime: "vercel",
      attempt: pending.vercel.attempt,
      workerToken: WORKER,
    })).rejects.toThrow("Authentication required");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.failCapabilityProof, {
      proofId: pending.vercel.proofId,
      runtime: "vercel",
      attempt: pending.vercel.attempt,
      ...owner,
    })).resolves.toBe(true);

    const retried = await t.mutation(migrationApi.creationAssetStoreMigration.beginPreflight, owner) as any;
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.failCapabilityProof, {
      proofId: retried.trigger.proofId,
      runtime: "trigger",
      attempt: retried.trigger.attempt,
      workerToken: WORKER,
    })).resolves.toBe(true);
  });

  it("refuses to freeze V1 until both runtimes have durable V2 capability proof", async () => {
    const t = convexTest(schema, modules);
    const assetId = "817fcdd9-43d8-46f7-bc89-5205af27d284";
    const owner = await ownerCredentials(t);

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.start, owner))
      .rejects.toThrow("Vercel and Trigger V2 capability proofs");
    await expect(t.query(migrationApi.creationAssetStoreMigration.status, owner)).resolves.toBeNull();
    // The failed start made no durable freeze, so legacy V1 writes still work.
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Still writable before proof",
      assetR2Key: v1Key(assetId),
      workerToken: WORKER,
    })).resolves.toEqual(expect.any(String));

    await expect(startWithProvenV2(t)).resolves.toMatchObject({ state: "snapshotting", attempt: 1 });
  });

  it("durably freezes V1, snapshots exact sources, and permits activation only after verified CAS cutover", async () => {
    const t = convexTest(schema, modules);
    const { id, key } = await seedV1Creation(t, "f47ac10b-58cc-4372-a567-0e02b2c3d479");

    await expect(startWithProvenV2(t))
      .resolves.toMatchObject({ state: "snapshotting", snapshotComplete: false, expectedCount: 0 });

    // The state insert is the freeze point, before a paginated manifest exists.
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Must not escape the snapshot",
      assetR2Key: v1Key("817fcdd9-43d8-46f7-bc89-5205af27d284"),
      workerToken: WORKER,
    })).rejects.toThrow("frozen");
    await expect(t.mutation(migrationApi.creationAssetCleanup.reserve, {
      assetR2Key: v1Key("817fcdd9-43d8-46f7-bc89-5205af27d284"),
      writerEpoch: "migration-freeze-private-writer",
      workerToken: WORKER,
    })).rejects.toThrow("frozen");

    await expect(completeSnapshot(t)).resolves.toMatchObject({
      state: "frozen",
      snapshotComplete: true,
      expectedCount: 1,
      verifiedCount: 0,
    });

    const pending = await t.query(migrationApi.creationAssetStoreMigration.pendingCreationIds, { workerToken: WORKER });
    expect(pending).toEqual([{ creationId: String(id) }]);
    expect(JSON.stringify(pending)).not.toContain(key);

    const claim = await t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER });
    expect(claim).toMatchObject({
      ready: true,
      creationId: String(id),
      source: { assetStore: "private-r2-v1", assetLocator: key },
      destination: {
        assetStore: "private-r2-v2",
        assetLocator: `owners/daniel/creation-assets-v2/migration/1/${String(id)}/generation/1/asset`,
      },
      contentType: "image/png",
      maxBytes: 30 * 1024 * 1024,
    });

    await expect(t.mutation(
      migrationApi.creationAssetStoreMigration.issueDestinationDeletionTicket,
      { creationId: id, ...(await ownerCredentials(t)) },
    )).rejects.toThrow("verified cutover destination");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t)))
      .rejects.toThrow("full verified migration");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.verifyCopy, {
      creationId: id,
      ticketId: claim.ticketId,
      sha256: "a".repeat(64),
      sizeBytes: 3,
      contentType: "image/png",
      workerToken: WORKER,
    })).resolves.toMatchObject({ state: "cutover_ready", expectedCount: 1, verifiedCount: 1, cutoverCount: 0 });

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t)))
      .resolves.toMatchObject({ state: "cutting_over", cutoverCount: 1 });
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t)))
      .resolves.toMatchObject({ state: "cutover", expectedCount: 1, verifiedCount: 1, cutoverCount: 1 });

    // A destination deletion ticket is minted only from the exact verified
    // cutover generation; no caller-supplied storage coordinate is exposed.
    const deletionTicket = await t.mutation(
      migrationApi.creationAssetStoreMigration.issueDestinationDeletionTicket,
      { creationId: id, ...(await ownerCredentials(t)) },
    );
    expect(deletionTicket).toEqual({ ticketId: expect.any(String), creationId: String(id) });
    expect(JSON.stringify(deletionTicket)).not.toContain("assetLocator");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.activate, await ownerCredentials(t)))
      .resolves.toMatchObject({ activeStore: "private-r2-v2", state: "activated" });

    await expect(t.query(api.creations.getForMedia, { id, workerToken: WORKER })).resolves.toMatchObject({
      assetStore: "private-r2-v2",
      assetLocator: `owners/daniel/creation-assets-v2/migration/1/${String(id)}/generation/1/asset`,
    });
    await expect(t.query(api.creations.get, { id, workerToken: WORKER })).resolves.not.toHaveProperty("assetLocator");

    // The activation mutation persists the only state that admits V2 writes;
    // a selector/config flip alone cannot make V2 reservation or metadata
    // creation legal.
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Activated V2 write",
      assetStore: "private-r2-v2",
      assetLocator: v2LiveKey("7d1c4ea4-0000-4fa2-9b00-000000000001"),
      workerToken: WORKER,
    })).resolves.toEqual(expect.any(String));

    const [manifest] = await t.run(async (ctx) => await ctx.db
      .query("creationAssetStoreMigrationItems")
      .withIndex("by_migration_creation", (q) => q.eq("migrationKey", "private-creation-r2-v2").eq("creationId", id))
      .collect());
    expect(manifest).toMatchObject({
      sourceStore: "private-r2-v1",
      sourceLocator: key,
      destinationStore: "private-r2-v2",
      destinationGeneration: 1,
      verifiedDestinationGeneration: 1,
      state: "cutover",
    });
    // Source V1 identity is audit data, never a cleanup or deletion request.
    await expect(t.run(async (ctx) => await ctx.db.query("creationAssetCleanupIntents").collect())).resolves.toEqual([]);
  });

  it("allows a pre-cutover abort to unfreeze V1 while keeping V2 gated and isolates the restart attempt", async () => {
    const t = convexTest(schema, modules);
    const { id } = await seedV1Creation(t, "9d1c4ea4-0000-4fa2-9b00-000000000001");
    await startWithProvenV2(t);

    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Premature V2 write",
      assetStore: "private-r2-v2",
      assetLocator: v2LiveKey("8d1c4ea4-0000-4fa2-9b00-000000000001"),
      workerToken: WORKER,
    })).rejects.toThrow("durable migration activation");
    await expect(t.mutation(migrationApi.creationAssetCleanup.reserve, {
      assetStore: "private-r2-v2",
      assetLocator: v2LiveKey("8d1c4ea4-0000-4fa2-9b00-000000000001"),
      assetR2Key: v2LiveKey("8d1c4ea4-0000-4fa2-9b00-000000000001"),
      writerEpoch: "abort-preflight-v2-writer-epoch",
      workerToken: WORKER,
    })).rejects.toThrow("cannot write to V2");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.abort, {
      reason: "operator corrected V2 runtime provisioning",
      ...(await ownerCredentials(t)),
    })).resolves.toMatchObject({ state: "aborted", attempt: 1 });
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "V1 reopened after safe abort",
      assetR2Key: v1Key("ad1c4ea4-0000-4fa2-9b00-000000000001"),
      workerToken: WORKER,
    })).resolves.toEqual(expect.any(String));
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "V2 remains unavailable after abort",
      assetStore: "private-r2-v2",
      assetLocator: v2LiveKey("bd1c4ea4-0000-4fa2-9b00-000000000001"),
      workerToken: WORKER,
    })).rejects.toThrow("durable migration activation");

    // The old proof cannot be replayed after abort; the next freeze needs a
    // fresh pair and gets a distinct V2 destination namespace.
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.start, await ownerCredentials(t)))
      .rejects.toThrow("Vercel and Trigger V2 capability proofs");
    await proveV2Preflight(t, 2);
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.start, await ownerCredentials(t)))
      .resolves.toMatchObject({ state: "snapshotting", attempt: 2 });
    await completeSnapshot(t);
    const restartItems = await t.run(async (ctx) => await ctx.db
      .query("creationAssetStoreMigrationItems")
      .withIndex("by_migration_attempt_state", (q) => q
        .eq("migrationKey", "private-creation-r2-v2")
        .eq("attempt", 2)
        .eq("state", "pending"))
      .collect());
    expect(restartItems.map((item) => item.creationId)).toContain(id);
    expect(restartItems.every((item) => item.destinationLocator === undefined)).toBe(true);
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER }))
      .resolves.toMatchObject({
        destination: {
          assetStore: "private-r2-v2",
          assetLocator: `owners/daniel/creation-assets-v2/migration/2/${String(id)}/generation/1/asset`,
        },
      });
  });

  it("keeps the verified retry generation live when a delayed expired worker finally writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const t = convexTest(schema, modules);
    const { id } = await seedV1Creation(t, "4ddc0ae2-3f66-49e7-bddb-b1bf5ca8af14");
    await startWithProvenV2(t);
    await completeSnapshot(t);

    const objects = new Map<string, Uint8Array>();
    const w1 = await t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER });
    expect(w1).toMatchObject({ ready: true, destination: { assetLocator: expect.stringContaining("/generation/1/") } });
    const prewrittenW1Bytes = new Uint8Array([0x77]);
    // The old worker has already begun writing an object under the target it
    // was issued. It may later finish that accepted PUT even after its lease
    // expires, so it must never share W2's target.
    objects.set(w1.destination.assetLocator, new Uint8Array(prewrittenW1Bytes));
    const delayedW1Bytes = new Uint8Array([0x77, 0x31]);
    // Model a V2 PUT that was authorized while W1 owned its lease but does not
    // finish until after W2's distinct generation is verified and cut over.
    const finishDelayedW1Put = () => objects.set(w1.destination.assetLocator, new Uint8Array(delayedW1Bytes));

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    const w2 = await t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER });
    expect(w2).toMatchObject({ ready: true, destination: { assetLocator: expect.stringContaining("/generation/2/") } });
    expect(w2.destination.assetLocator).not.toBe(w1.destination.assetLocator);

    const verifiedW2Bytes = new Uint8Array([0x77, 0x32]);
    const verifiedW2Sha = createHash("sha256").update(verifiedW2Bytes).digest("hex");
    objects.set(w2.destination.assetLocator, new Uint8Array(verifiedW2Bytes));
    await t.mutation(migrationApi.creationAssetStoreMigration.verifyCopy, {
      creationId: id,
      ticketId: w2.ticketId,
      sha256: verifiedW2Sha,
      sizeBytes: verifiedW2Bytes.byteLength,
      workerToken: WORKER,
    });
    await t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t));
    await t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t));

    const beforeLatePut = await t.query(api.creations.getForMedia, { id, workerToken: WORKER });
    if (!beforeLatePut?.assetLocator) throw new Error("W2 cutover did not persist a media locator");
    expect(beforeLatePut).toMatchObject({
      assetStore: "private-r2-v2",
      assetLocator: w2.destination.assetLocator,
    });
    expect(objects.get(beforeLatePut.assetLocator)).toEqual(verifiedW2Bytes);

    finishDelayedW1Put();

    const afterLatePut = await t.query(api.creations.getForMedia, { id, workerToken: WORKER });
    if (!afterLatePut?.assetLocator) throw new Error("late W1 write removed the media locator");
    expect(afterLatePut).toMatchObject({
      assetStore: "private-r2-v2",
      assetLocator: w2.destination.assetLocator,
    });
    expect(afterLatePut.assetLocator).not.toBe(w1.destination.assetLocator);
    expect(objects.get(afterLatePut.assetLocator)).toEqual(verifiedW2Bytes);
    expect(objects.get(w1.destination.assetLocator)).toEqual(delayedW1Bytes);

    const [manifest] = await t.run(async (ctx) => await ctx.db
      .query("creationAssetStoreMigrationItems")
      .withIndex("by_migration_creation", (q) => q.eq("migrationKey", "private-creation-r2-v2").eq("creationId", id))
      .collect());
    expect(manifest).toMatchObject({
      destinationLocator: w2.destination.assetLocator,
      destinationGeneration: 2,
      verifiedDestinationLocator: w2.destination.assetLocator,
      verifiedDestinationGeneration: 2,
      sha256: verifiedW2Sha,
      state: "cutover",
    });
  });

  it("revokes stale copy tickets and refuses a CAS cutover when a frozen source changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const t = convexTest(schema, modules);
    const { id } = await seedV1Creation(t, "6af437ee-05f0-42f0-9588-35a2745084ca");
    await startWithProvenV2(t);
    await completeSnapshot(t);

    const first = await t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER });
    expect(first).toMatchObject({ ready: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    const second = await t.mutation(migrationApi.creationAssetStoreMigration.claimCopy, { creationId: id, workerToken: WORKER });
    expect(second).toMatchObject({ ready: true, ticketId: expect.any(String) });
    expect(second.ticketId).not.toBe(first.ticketId);
    expect(second.destination.assetLocator).not.toBe(first.destination.assetLocator);
    expect(second.destination.assetLocator).toContain("/generation/2/");

    await expect(t.mutation(migrationApi.creationAssetStoreMigration.verifyCopy, {
      creationId: id,
      ticketId: first.ticketId,
      sha256: "b".repeat(64),
      sizeBytes: 3,
      workerToken: WORKER,
    })).rejects.toThrow("ticket is no longer current");

    await t.mutation(migrationApi.creationAssetStoreMigration.verifyCopy, {
      creationId: id,
      ticketId: second.ticketId,
      sha256: "b".repeat(64),
      sizeBytes: 3,
      workerToken: WORKER,
    });

    // Simulate a concurrent out-of-band row change. Cutover rechecks the
    // frozen source in its own mutation and fails rather than partly moving.
    await t.run(async (ctx) => await ctx.db.patch(id, {
      assetR2Key: v1Key("28a90f9d-9270-4dbb-b8f5-d4e3f3e77d9b"),
      updatedAt: Date.now(),
    }));
    await expect(t.mutation(migrationApi.creationAssetStoreMigration.cutoverStep, await ownerCredentials(t)))
      .resolves.toMatchObject({ state: "failed" });
    await expect(t.query(migrationApi.creationAssetStoreMigration.status, await ownerCredentials(t)))
      .resolves.toMatchObject({ state: "failed" });
  });
});
