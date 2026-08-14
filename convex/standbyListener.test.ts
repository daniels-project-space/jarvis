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
const WORKER = "standby-listener-test-worker";
const OWNER = "b".repeat(64);

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

async function ownerSession(t: ReturnType<typeof convexTest>) {
  await t.mutation(api.controlAuth.createOpenSession, {
    ownerTokenHash: OWNER,
    workerToken: WORKER,
  });
}

describe("standby listener lease", () => {
  it("fences a second listener until the owner releases it", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    await expect(t.mutation(api.ui.setStandbyListener, {
      client: "main-tab",
      on: true,
      authTokenHash: OWNER,
    })).resolves.toBe(true);
    await expect(t.mutation(api.ui.setStandbyListener, {
      client: "overlay-frame",
      on: true,
      authTokenHash: OWNER,
    })).resolves.toBe(false);
    await expect(t.query(api.ui.getStandbyListener, { workerToken: WORKER }))
      .resolves.toMatchObject({ value: "main-tab" });

    await t.mutation(api.ui.setStandbyListener, {
      client: "main-tab",
      on: false,
      authTokenHash: OWNER,
    });
    await expect(t.mutation(api.ui.setStandbyListener, {
      client: "overlay-frame",
      on: true,
      authTokenHash: OWNER,
    })).resolves.toBe(true);
  });

  it("expires exactly at the handoff boundary so another listener can claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-14T10:00:00Z"));
      const t = convexTest(schema, modules);
      await ownerSession(t);

      await expect(t.mutation(api.ui.setStandbyListener, {
        client: "main-tab",
        on: true,
        authTokenHash: OWNER,
      })).resolves.toBe(true);

      vi.advanceTimersByTime(24_999);
      await expect(t.query(api.ui.getStandbyListener, { workerToken: WORKER }))
        .resolves.toMatchObject({ value: "main-tab" });

      vi.advanceTimersByTime(1);
      await expect(t.query(api.ui.getStandbyListener, { workerToken: WORKER })).resolves.toBeNull();
      await expect(t.mutation(api.ui.setStandbyListener, {
        client: "overlay-frame",
        on: true,
        authTokenHash: OWNER,
      })).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose or mutate the lease without an owner capability", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.ui.setStandbyListener, {
      client: "untrusted",
      on: true,
    })).rejects.toThrow(/Authentication required/i);
    await expect(t.query(api.ui.getStandbyListener, {})).rejects.toThrow(/Authentication required/i);
  });
});
