import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "private-media-test-worker";
const PRIVATE_KEY = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
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
});
