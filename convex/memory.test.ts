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
const WORKER = "memory-test-worker";

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.useRealTimers();
});

describe("governed durable memory", () => {
  it("consolidates the same canonical claim and retains bounded provenance", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation((api as any).memory.write, {
      kind: "preference",
      title: "Daniel prefers concise evidence-backed updates",
      body: "Use concise updates with supporting evidence when decisions matter.",
      tags: ["communication"],
      confidence: 0.72,
      sourceMessageId: "message_1",
      workerToken: WORKER,
    });
    const second = await t.mutation((api as any).memory.write, {
      kind: "preference",
      title: "Daniel prefers concise evidence-backed updates",
      body: "Lead with the outcome and preserve evidence for consequential choices.",
      tags: ["communication", "decision-making"],
      confidence: 0.9,
      sourceMessageId: "message_2",
      workerToken: WORKER,
    });
    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query("memory").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revision: 2,
      confidence: 0.9,
      sourceMessageIds: ["message_1", "message_2"],
      dedupeKey: "v1:preference:daniel-prefers-concise-evidence-backed-updates",
    });
  });

  it("drains same-timestamp revisions across pages and resumes without skipping the mirror", async () => {
    const t = convexTest(schema, modules);
    const titles = Array.from({ length: 31 }, (_, index) => `Canonical memory ${String(index).padStart(2, "0")}`);
    // This is the original failure shape: a long-lived canonical row changes
    // after newer rows exist. Its revision deliberately shares their exact
    // updatedAt, so the cursor must still visit all 31 records.
    await t.mutation((api as any).memory.write, {
      kind: "fact",
      title: titles[0],
      body: `Initial durable content for ${titles[0]}.`,
      workerToken: WORKER,
    });
    vi.advanceTimersByTime(1_000);
    for (const title of titles.slice(1)) {
      await t.mutation((api as any).memory.write, {
        kind: "fact",
        title,
        body: `Initial durable content for ${title}.`,
        workerToken: WORKER,
      });
    }
    await t.mutation((api as any).memory.write, {
      kind: "fact",
      title: titles[0],
      body: "Same-timestamp revision of the old canonical memory.",
      workerToken: WORKER,
    });

    const firstCycle = await t.mutation((api as any).memory.beginObsidianReconciliation, { workerToken: WORKER });
    const firstPage = await t.query((api as any).memory.obsidianReconciliationPage, {
      cycle: firstCycle.cycle,
      cutoffAt: firstCycle.cutoffAt,
      workerToken: WORKER,
    });
    expect(firstPage).toMatchObject({ isDone: false });
    expect(firstPage.items).toHaveLength(30);
    expect(new Set(firstPage.items.map((item: { title: string }) => item.title))).toHaveLength(30);
    expect(firstPage.items).toContainEqual(expect.objectContaining({
      title: titles[0],
      body: "Same-timestamp revision of the old canonical memory.",
    }));
    expect(typeof firstPage.continueCursor).toBe("string");

    const firstCheckpoint = {
      cycle: firstCycle.cycle,
      cutoffAt: firstCycle.cutoffAt,
      continueCursor: firstPage.continueCursor,
      complete: false,
      workerToken: WORKER,
    };
    // A worker that crashes after Git push but before receiving its mutation
    // response may submit the same checkpoint again; that remains safe.
    expect(await t.mutation((api as any).memory.advanceObsidianReconciliation, firstCheckpoint))
      .toMatchObject({ ok: true, idempotent: false, complete: false });
    expect(await t.mutation((api as any).memory.advanceObsidianReconciliation, firstCheckpoint))
      .toMatchObject({ ok: true, idempotent: true, complete: false });

    // This revision lands after the frozen cutoff while the first cycle is
    // paused on its continuation cursor. It cannot be allowed to disappear
    // behind that cursor; the following cycle must deliver it.
    vi.advanceTimersByTime(1_000);
    await t.mutation((api as any).memory.write, {
      kind: "fact",
      title: titles[0],
      body: "Revised durable content that must reach Obsidian after the old rows.",
      workerToken: WORKER,
    });

    const resumed = await t.mutation((api as any).memory.beginObsidianReconciliation, { workerToken: WORKER });
    expect(resumed).toMatchObject({ cycle: firstCycle.cycle, cutoffAt: firstCycle.cutoffAt, cursor: firstPage.continueCursor });
    const finalFirstCyclePage = await t.query((api as any).memory.obsidianReconciliationPage, {
      cycle: resumed.cycle,
      cutoffAt: resumed.cutoffAt,
      cursor: resumed.cursor,
      workerToken: WORKER,
    });
    expect(finalFirstCyclePage).toMatchObject({ isDone: true });
    expect(finalFirstCyclePage.items).toHaveLength(1);
    const firstCycleTitles = [
      ...firstPage.items.map((item: { title: string }) => item.title),
      ...finalFirstCyclePage.items.map((item: { title: string }) => item.title),
    ];
    expect(new Set(firstCycleTitles)).toEqual(new Set(titles));
    expect(await t.mutation((api as any).memory.advanceObsidianReconciliation, {
      cycle: resumed.cycle,
      cutoffAt: resumed.cutoffAt,
      fromCursor: resumed.cursor,
      complete: true,
      workerToken: WORKER,
    })).toMatchObject({ ok: true, complete: true });

    // The post-cutoff revision arrives only after the 30 unchanged records
    // in the next cycle, proving that the frozen cursor did not skip it.
    const nextCycle = await t.mutation((api as any).memory.beginObsidianReconciliation, { workerToken: WORKER });
    const nextFirstPage = await t.query((api as any).memory.obsidianReconciliationPage, {
      cycle: nextCycle.cycle,
      cutoffAt: nextCycle.cutoffAt,
      workerToken: WORKER,
    });
    expect(nextFirstPage).toMatchObject({ isDone: false });
    expect(nextFirstPage.items).toHaveLength(30);
    expect(nextFirstPage.items.map((item: { title: string }) => item.title)).not.toContain(titles[0]);
    expect(await t.mutation((api as any).memory.advanceObsidianReconciliation, {
      cycle: nextCycle.cycle,
      cutoffAt: nextCycle.cutoffAt,
      continueCursor: nextFirstPage.continueCursor,
      complete: false,
      workerToken: WORKER,
    })).toMatchObject({ ok: true, complete: false });
    const nextFinalPage = await t.query((api as any).memory.obsidianReconciliationPage, {
      cycle: nextCycle.cycle,
      cutoffAt: nextCycle.cutoffAt,
      cursor: nextFirstPage.continueCursor,
      workerToken: WORKER,
    });
    expect(nextFinalPage).toMatchObject({ isDone: true });
    expect(nextFinalPage.items).toEqual([
      expect.objectContaining({
        title: titles[0],
        body: "Revised durable content that must reach Obsidian after the old rows.",
      }),
    ]);
  });

  it("rejects an old completed checkpoint when a new scan begins in the same millisecond", async () => {
    const t = convexTest(schema, modules);
    await t.mutation((api as any).memory.write, {
      kind: "fact",
      title: "Generation guard memory",
      body: "This canonical memory verifies that stale workers cannot end a newer scan.",
      workerToken: WORKER,
    });
    const first = await t.mutation((api as any).memory.beginObsidianReconciliation, { workerToken: WORKER });
    const page = await t.query((api as any).memory.obsidianReconciliationPage, {
      cycle: first.cycle,
      cutoffAt: first.cutoffAt,
      workerToken: WORKER,
    });
    expect(page).toMatchObject({ isDone: true });
    const completedCheckpoint = {
      cycle: first.cycle,
      cutoffAt: first.cutoffAt,
      complete: true,
      workerToken: WORKER,
    };
    expect(await t.mutation((api as any).memory.advanceObsidianReconciliation, completedCheckpoint))
      .toMatchObject({ ok: true, complete: true });

    // Fake time has not advanced: cutoffAt is intentionally allowed to tie,
    // while the durable generation still distinguishes the newer scan.
    const next = await t.mutation((api as any).memory.beginObsidianReconciliation, { workerToken: WORKER });
    expect(next).toMatchObject({ cycle: first.cycle + 1, cutoffAt: first.cutoffAt });
    await expect(t.mutation((api as any).memory.advanceObsidianReconciliation, completedCheckpoint))
      .rejects.toThrow(/checkpoint is stale/i);
  });

  it("rejects invalid provenance and unreasonable expiration", async () => {
    const t = convexTest(schema, modules);
    const base = {
      kind: "fact",
      title: "A durable fact",
      body: "This is a safe durable fact with no secret material.",
      workerToken: WORKER,
    };
    await expect(t.mutation((api as any).memory.write, { ...base, sourceMessageId: "not valid" }))
      .rejects.toThrow(/source message id/i);
    await expect(t.mutation((api as any).memory.write, { ...base, expiresAt: Date.now() }))
      .rejects.toThrow(/expiration/i);
  });
});
