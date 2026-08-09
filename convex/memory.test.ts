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
