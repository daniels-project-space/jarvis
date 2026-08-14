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
const WORKER = "live-on-lease-test-worker";
const OWNER = "c".repeat(64);

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

describe("live mode lease", () => {
  it("keeps a newer same-client lease when delayed old requests arrive", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);

    const first = {
      client: "main-tab",
      on: true,
      liveLeaseId: "first-start",
      liveLeaseSequence: 101,
      authTokenHash: OWNER,
    };
    const second = {
      ...first,
      liveLeaseId: "second-start",
      liveLeaseSequence: 102,
    };

    await expect(t.mutation(api.ui.setLiveOn, first)).resolves.toBe(true);
    await expect(t.mutation(api.ui.setLiveOn, second)).resolves.toBe(true);
    await expect(t.mutation(api.ui.setLiveOn, { ...first, on: false })).resolves.toBe(true);
    await expect(t.mutation(api.ui.setLiveOn, first)).resolves.toBe(false);
    await expect(t.query(api.ui.getLiveOn, { workerToken: WORKER })).resolves.toMatchObject({
      value: "main-tab",
      liveLeaseId: "second-start",
      liveLeaseSequence: 102,
    });

    await t.mutation(api.ui.setLiveOn, { ...second, on: false });
    await expect(t.query(api.ui.getLiveOn, { workerToken: WORKER })).resolves.toBeNull();
  });
});
