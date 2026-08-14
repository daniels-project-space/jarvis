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
const WORKER = "ui-legacy-media-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

describe("legacy creation panel media", () => {
  it("maps a historical raw panel value to the authenticated media route", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/panel.png";
    const creationId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("creations", {
        kind: "image",
        title: "Historic panel",
        url: legacyUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("ui", {
        key: "panel",
        type: "image",
        value: `${legacyUrl}?download=1`,
        title: `Historic ${legacyUrl}`,
        updatedAt: Date.now(),
      });
      return id;
    });

    const panel = await t.query(api.ui.getPanel, { workerToken: WORKER });

    expect(panel).toMatchObject({
      type: "image",
      value: `/api/creation-media?id=${encodeURIComponent(String(creationId))}&variant=asset`,
    });
    expect(JSON.stringify(panel)).not.toContain(legacyUrl);
  });

  it("normalizes a newly written legacy panel before persisting it", async () => {
    const t = convexTest(schema, modules);
    const legacyUrl = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/write.png";
    const creationId = await t.run((ctx) => ctx.db.insert("creations", {
      kind: "image",
      title: "Write panel",
      thumb: legacyUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    await t.mutation(api.ui.setPanel, { type: "image", value: legacyUrl, workerToken: WORKER });
    const stored = await t.run((ctx) => ctx.db.query("ui").withIndex("by_key", (q) => q.eq("key", "panel")).first());

    expect(stored?.value).toBe(`/api/creation-media?id=${encodeURIComponent(String(creationId))}&variant=asset`);
    expect(JSON.stringify(stored)).not.toContain(legacyUrl);
  });
});
