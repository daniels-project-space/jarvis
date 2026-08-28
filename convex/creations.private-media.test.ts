import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import {
  CREATION_ASSET_SWEEP_INTERVAL_MS,
  CREATION_ASSET_WRITER_LEASE_MS,
} from "./creationAssetCleanup";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "private-media-test-worker";
const PRIVATE_KEY = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
const WRITER_EPOCH = "private-creation-writer-epoch";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

describe("private creation media records", () => {
  it("redacts storage keys from regular creation reads while allowing the narrow media lookup", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "image",
      title: "Private sunset",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const viewer = await t.query(api.creations.get, { id, workerToken: WORKER });
    expect(viewer).toMatchObject({
      _id: id,
      hasPrivateAsset: true,
      url: `/api/creation-media?id=${encodeURIComponent(String(id))}&variant=asset`,
      thumb: `/api/creation-media?id=${encodeURIComponent(String(id))}&variant=asset`,
    });
    expect(viewer).not.toHaveProperty("assetR2Key");
    expect(viewer).not.toHaveProperty("assetContentType");

    await expect(t.query(api.creations.getForMedia, { id, workerToken: WORKER })).resolves.toEqual({
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      title: "Private sunset",
      kind: "image",
    });
  });

  it("masks trusted legacy public creation URLs behind the media route", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/legacy.png";
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "image",
      title: "Legacy image",
      url: legacyUrl,
      thumb: legacyUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const viewer = await t.query(api.creations.get, { id, workerToken: WORKER });
    const mediaUrl = `/api/creation-media?id=${encodeURIComponent(String(id))}&variant=asset`;
    expect(viewer).toMatchObject({ hasPrivateAsset: false, url: mediaUrl, thumb: mediaUrl });
    expect(JSON.stringify(viewer)).not.toContain("r2.dev");
    await expect(t.query(api.creations.getForMedia, { id, workerToken: WORKER })).resolves.toEqual({
      legacyUrl,
      title: "Legacy image",
      kind: "image",
    });
  });

  it("rejects non-opaque asset keys before any creation is persisted", async () => {
    const t = convexTest(schema, modules);

    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Unsafe",
      assetR2Key: "owners/daniel/files/other/v1/original",
      workerToken: WORKER,
    })).rejects.toThrow("invalid private creation asset key");
  });

  it("treats an exact owner retry after private-media cleanup as a successful deletion", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "image",
      title: "Retry-safe private image",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.mutation(api.creations.remove, { id, workerToken: WORKER })).resolves.toBe(true);
    await expect(t.mutation(api.creations.remove, { id, workerToken: WORKER })).resolves.toBe(true);
    await expect(t.query(api.creations.get, { id, workerToken: WORKER })).resolves.toBeNull();
  });

  it("uses only the authenticated owner and exact opaque asset key as the create retry identity", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Unauthenticated",
      assetR2Key: PRIVATE_KEY,
    })).rejects.toThrow("Authentication required");

    await t.mutation(cleanupApi.creationAssetCleanup.reserve, { assetR2Key: PRIVATE_KEY, writerEpoch: WRITER_EPOCH, workerToken: WORKER });
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "A different writer cannot consume this lease",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: "different-private-writer",
      workerToken: WORKER,
    })).rejects.toThrow("no longer writable");
    const first = await t.mutation(api.creations.create, {
      kind: "image",
      title: "Original title",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });
    const retry = await t.mutation(api.creations.create, {
      kind: "image",
      title: "A different request body cannot create a second row",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/webp",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });

    expect(retry).toBe(first);
    await expect(t.query(api.creations.getByAssetR2Key, { assetR2Key: PRIVATE_KEY, workerToken: WORKER }))
      .resolves.toBe(String(first));
    await expect(t.run(async (ctx) => await ctx.db
      .query("creationAssetCleanupIntents")
      .withIndex("by_assetR2Key", (q) => q.eq("assetR2Key", PRIVATE_KEY))
      .collect())).resolves.toEqual([]);
  });

  it("does not let a foreign writer epoch abandon or mark a live writer for cleanup", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    const foreignEpoch = "foreign-private-creation-writer";
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });

    await expect(t.mutation(cleanupApi.creationAssetCleanup.markWritten, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: foreignEpoch,
      workerToken: WORKER,
    })).resolves.toEqual({ state: "writer_mismatch" });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.abandon, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: foreignEpoch,
      workerToken: WORKER,
    })).resolves.toEqual({ state: "writer_mismatch" });

    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER })).resolves.toEqual([]);
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Legitimate writer remains live",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).resolves.toEqual(expect.any(String));
  });

  it("fails closed if an epoch-bearing producer loses its durable reservation", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Unfenced private object",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).rejects.toThrow("reservation is unavailable");
  });

  it("keeps an old no-epoch producer compatible while the new Convex contract rolls out first", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Legacy producer during rollout",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      workerToken: WORKER,
    })).resolves.toEqual(expect.any(String));
  });

  it("gives cleanup a bounded lease and refuses a late create before it can reference a deleted object", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, { assetR2Key: PRIVATE_KEY, writerEpoch: WRITER_EPOCH, workerToken: WORKER });
    await t.mutation(cleanupApi.creationAssetCleanup.abandon, { assetR2Key: PRIVATE_KEY, writerEpoch: WRITER_EPOCH, workerToken: WORKER });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    const claim = await t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "private-creation-cleanup-claim",
      workerToken: WORKER,
    });
    expect(claim).toMatchObject({ ready: true, assetR2Key: PRIVATE_KEY });

    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Too late",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      workerToken: WORKER,
    })).rejects.toThrow("no longer writable");

    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "private-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ finished: true, preserved: false });
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Stale network retry",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      workerToken: WORKER,
    })).rejects.toThrow("no longer writable");
  });

  it("serializes an expired cleanup claim against a delayed writer create so cleanup owns exactly one durable transition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:15:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });
    await vi.advanceTimersByTimeAsync(CREATION_ASSET_WRITER_LEASE_MS + 1);

    const [claim, delayedCreate] = await Promise.allSettled([
      t.mutation(cleanupApi.creationAssetCleanup.claim, {
        assetR2Key: PRIVATE_KEY,
        claimToken: "concurrent-expired-cleanup-claim",
        workerToken: WORKER,
      }),
      t.mutation(api.creations.create, {
        kind: "image",
        title: "Delayed writer must not win after recovery",
        assetR2Key: PRIVATE_KEY,
        assetContentType: "image/png",
        assetWriteEpoch: WRITER_EPOCH,
        workerToken: WORKER,
      }),
    ]);

    expect(claim).toMatchObject({ status: "fulfilled", value: { ready: true, assetR2Key: PRIVATE_KEY } });
    expect(delayedCreate.status).toBe("rejected");
    await expect(t.query(api.creations.getByAssetR2Key, { assetR2Key: PRIVATE_KEY, workerToken: WORKER }))
      .resolves.toBeNull();
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "concurrent-expired-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });
  });

  it("never hands cleanup ownership to a live writer whose creation commit wins the race", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });

    const [created, claim] = await Promise.all([
      t.mutation(api.creations.create, {
        kind: "image",
        title: "Winning creation",
        assetR2Key: PRIVATE_KEY,
        assetContentType: "image/png",
        assetWriteEpoch: WRITER_EPOCH,
        workerToken: WORKER,
      }),
      t.mutation(cleanupApi.creationAssetCleanup.claim, {
        assetR2Key: PRIVATE_KEY,
        claimToken: "live-writer-concurrent-cleanup-claim",
        workerToken: WORKER,
      }),
    ]);

    expect(typeof created).toBe("string");
    expect(claim).not.toMatchObject({ ready: true });
    await expect(t.query(api.creations.getByAssetR2Key, { assetR2Key: PRIVATE_KEY, workerToken: WORKER }))
      .resolves.toBe(String(created));
  });

  it("reopens a write-origin cleanup reaper when an R2 PUT resolves after the first delete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:30:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;

    await t.mutation(cleanupApi.creationAssetCleanup.reserve, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });
    // This is the exact durable record returned to the storage primitive just
    // before its PUT begins. Keep the PUT unresolved while cleanup expires.
    await expect(t.mutation(cleanupApi.creationAssetCleanup.renewForWrite, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).resolves.toMatchObject({ writerDeadlineAt: expect.any(Number) });

    await vi.advanceTimersByTimeAsync(CREATION_ASSET_WRITER_LEASE_MS + 1);
    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "late-r2-first-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "late-r2-first-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });

    // The delayed PUT now completes. It cannot revive a creation: its same
    // epoch turns the retained sweep into a durable immediate re-delete.
    await expect(t.mutation(cleanupApi.creationAssetCleanup.markWritten, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).resolves.toEqual({ state: "cleanup_ready", reopened: true });
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Late R2 write must not revive metadata",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).rejects.toThrow("no longer writable");
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER }))
      .resolves.toEqual([{ assetR2Key: PRIVATE_KEY }]);

    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "late-r2-second-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "late-r2-second-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });
  });

  it("refuses a producer paused before the R2 boundary once its writer lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:40:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    });
    await vi.advanceTimersByTimeAsync(CREATION_ASSET_WRITER_LEASE_MS + 1);

    await expect(t.mutation(cleanupApi.creationAssetCleanup.renewForWrite, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).rejects.toThrow("lease expired before R2 write");
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER }))
      .resolves.toEqual([{ assetR2Key: PRIVATE_KEY }]);
  });

  it("retains a nonterminal deletion intent so a post-delete writer is swept again without a per-key Trigger chain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:45:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    const creationId = await t.run(async (ctx) => await ctx.db.insert("creations", {
      kind: "image",
      title: "Delete then late write",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    await t.mutation(api.creations.remove, { id: creationId, workerToken: WORKER });
    await t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-first-cleanup-claim",
      workerToken: WORKER,
    });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-first-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });

    // A stale object-store writer can still complete after the first delete.
    // The deletion-origin intent remains durable, so this late completion
    // reopens cleanup rather than becoming a terminal orphan.
    await expect(t.mutation(cleanupApi.creationAssetCleanup.markWritten, {
      assetR2Key: PRIVATE_KEY,
      writerEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).resolves.toEqual({ state: "cleanup_ready", reopened: true });
    await expect(t.mutation(api.creations.create, {
      kind: "image",
      title: "Late deletion writer cannot recreate metadata",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      assetWriteEpoch: WRITER_EPOCH,
      workerToken: WORKER,
    })).rejects.toThrow("no longer writable");
    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-second-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-second-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });

    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER })).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(CREATION_ASSET_SWEEP_INTERVAL_MS + 1);
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER }))
      .resolves.toEqual([{ assetR2Key: PRIVATE_KEY }]);
    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-periodic-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "nonterminal-periodic-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toEqual({ finished: true, preserved: false });
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER })).resolves.toEqual([]);
  });

  it("rechecks the canonical creation before a cleanup claim can own its private key", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("creations", {
        kind: "image",
        title: "Already committed",
        assetR2Key: PRIVATE_KEY,
        assetContentType: "image/png",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("creationAssetCleanupIntents", {
        assetR2Key: PRIVATE_KEY,
        state: "cleanup_ready",
        nextActionAt: now - 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "private-creation-canonical-check",
      workerToken: WORKER,
    })).resolves.toEqual({ ready: false, preserved: true });
    await expect(t.run(async (ctx) => await ctx.db
      .query("creationAssetCleanupIntents")
      .withIndex("by_assetR2Key", (q) => q.eq("assetR2Key", PRIVATE_KEY))
      .collect())).resolves.toEqual([]);
  });

  it("advertises the nonterminal cleanup contract to a Vercel-first rollout", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await expect(t.query(cleanupApi.creationAssetCleanup.protocol, { workerToken: WORKER }))
      .resolves.toEqual({ cleanupProtocol: "nonterminal-reaper-v1" });
  });

  it("records an asset cleanup intent atomically when a creation is deleted before cleanup runs", async () => {
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    const id = await t.run(async (ctx) => await ctx.db.insert("creations", {
      kind: "image",
      title: "Delete me safely",
      assetR2Key: PRIVATE_KEY,
      assetContentType: "image/png",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    await expect(t.mutation(api.creations.remove, { id, workerToken: WORKER })).resolves.toBe(true);
    await expect(t.query(api.creations.getByAssetR2Key, { assetR2Key: PRIVATE_KEY, workerToken: WORKER }))
      .resolves.toBeNull();
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER }))
      .resolves.toEqual([{ assetR2Key: PRIVATE_KEY }]);
    const claim = await t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "deleted-creation-cleanup-claim",
      workerToken: WORKER,
    });
    expect(claim).toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "deleted-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ finished: true, preserved: false });
  });

  it("moves a successfully swept key behind other due intents so periodic recovery remains fair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T13:30:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    const keys = [
      "owners/daniel/creations/6d1a41c0-4b0b-4a48-a728-dc7a0dc0bb11/asset",
      "owners/daniel/creations/7b2b52d1-5c1c-4b59-b839-ed8b1ed1cc22/asset",
      "owners/daniel/creations/8c3c63e2-6d2d-4c6a-aa4a-fe9c2fe2dd33/asset",
    ];
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const assetR2Key of keys) {
        await ctx.db.insert("creationAssetCleanupIntents", {
          assetR2Key,
          recoveryKind: "deletion",
          state: "cleanup_sweep",
          nextActionAt: now - 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const [first] = await t.query(cleanupApi.creationAssetCleanup.pending, { limit: 1, workerToken: WORKER });
    expect(first?.assetR2Key).toBeTruthy();
    const firstClaim = await t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: first.assetR2Key,
      claimToken: "fairness-first-cleanup-claim",
      workerToken: WORKER,
    });
    expect(firstClaim).toMatchObject({ ready: true });
    await t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: first.assetR2Key,
      claimToken: "fairness-first-cleanup-claim",
      workerToken: WORKER,
    });

    const [second] = await t.query(cleanupApi.creationAssetCleanup.pending, { limit: 1, workerToken: WORKER });
    expect(second?.assetR2Key).toBeTruthy();
    expect(second.assetR2Key).not.toBe(first.assetR2Key);
  });

  it("lets a new worker reclaim an expired cleanup claim while rejecting the stale claimant and retaining the reaper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T13:00:00Z"));
    const t = convexTest(schema, modules);
    const cleanupApi = api as any;
    await t.mutation(cleanupApi.creationAssetCleanup.reserve, { assetR2Key: PRIVATE_KEY, writerEpoch: WRITER_EPOCH, workerToken: WORKER });
    await t.mutation(cleanupApi.creationAssetCleanup.abandon, { assetR2Key: PRIVATE_KEY, writerEpoch: WRITER_EPOCH, workerToken: WORKER });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "stale-private-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    await expect(t.mutation(cleanupApi.creationAssetCleanup.claim, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "fresh-private-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ ready: true });
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "stale-private-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toBe(false);
    await expect(t.mutation(cleanupApi.creationAssetCleanup.finish, {
      assetR2Key: PRIVATE_KEY,
      claimToken: "fresh-private-creation-cleanup-claim",
      workerToken: WORKER,
    })).resolves.toMatchObject({ finished: true, preserved: false });
    await vi.advanceTimersByTimeAsync(CREATION_ASSET_SWEEP_INTERVAL_MS + 1);
    await expect(t.query(cleanupApi.creationAssetCleanup.pending, { workerToken: WORKER }))
      .resolves.toEqual([{ assetR2Key: PRIVATE_KEY }]);
  });
});
