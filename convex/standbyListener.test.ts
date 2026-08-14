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

function leaseRequest(
  client: string,
  on: boolean,
  standbyLeaseId: string,
  standbyLeaseSequence: number,
) {
  return {
    client,
    on,
    standbyLeaseId,
    standbyLeaseSequence,
    authTokenHash: OWNER,
  };
}

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

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("overlay-frame", true, "overlay-frame:1", 1),
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
    ).resolves.toMatchObject({ value: "main-tab" });

    await t.mutation(
      api.ui.setStandbyListener,
      leaseRequest("main-tab", false, "main-tab:1", 1),
    );
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("overlay-frame", true, "overlay-frame:1", 1),
      ),
    ).resolves.toBe(true);
  });

  it("fences copied client identifiers behind their distinct lease IDs", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("copied-session-client", true, "instance-a:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("copied-session-client", true, "instance-b:1", 1),
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
    ).resolves.toMatchObject({
      value: "copied-session-client",
      standbyLeaseId: "instance-a:1",
      standbyLeaseSequence: 1,
    });
  });

  it("tombstones a released lease so a delayed claim cannot resurrect it", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", false, "main-tab:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:1", 1),
      ),
    ).resolves.toBe(false);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:2", 2),
      ),
    ).resolves.toBe(true);
    await expect(
      t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
    ).resolves.toMatchObject({
      value: "main-tab",
      standbyLeaseId: "main-tab:2",
      standbyLeaseSequence: 2,
    });
  });

  it("keeps a released lease fenced after a different owner claims and releases", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("owner-a", false, "owner-a:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("owner-b", true, "owner-b:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("owner-b", false, "owner-b:1", 1),
      ),
    ).resolves.toBe(true);

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("owner-a", true, "owner-a:1", 1),
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
    ).resolves.toBeNull();
  });

  it("does not let an old lease token revive after a newer generation owns it", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", false, "main-tab:1", 1),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:2", 2),
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        api.ui.setStandbyListener,
        leaseRequest("main-tab", true, "main-tab:1", 1),
      ),
    ).resolves.toBe(false);
    await expect(
      t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
    ).resolves.toMatchObject({
      value: "main-tab",
      standbyLeaseId: "main-tab:2",
      standbyLeaseSequence: 2,
    });
  });

  it("expires exactly at the handoff boundary so another listener can claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-14T10:00:00Z"));
      const t = convexTest(schema, modules);
      await ownerSession(t);

      await expect(
        t.mutation(
          api.ui.setStandbyListener,
          leaseRequest("main-tab", true, "main-tab:1", 1),
        ),
      ).resolves.toBe(true);

      vi.advanceTimersByTime(24_999);
      await expect(
        t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
      ).resolves.toMatchObject({ value: "main-tab" });

      vi.advanceTimersByTime(1);
      await expect(
        t.query(api.ui.getStandbyListener, { workerToken: WORKER }),
      ).resolves.toBeNull();
      await expect(
        t.mutation(
          api.ui.setStandbyListener,
          leaseRequest("overlay-frame", true, "overlay-frame:1", 1),
        ),
      ).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose or mutate the lease without an owner capability", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.ui.setStandbyListener, {
        client: "untrusted",
        on: true,
        standbyLeaseId: "untrusted:1",
        standbyLeaseSequence: 1,
      }),
    ).rejects.toThrow(/Authentication required/i);
    await expect(t.query(api.ui.getStandbyListener, {})).rejects.toThrow(
      /Authentication required/i,
    );
  });
});
