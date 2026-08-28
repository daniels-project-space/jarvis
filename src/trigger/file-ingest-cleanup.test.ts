import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.CONVEX_URL = "https://convex.test";
  process.env.JARVIS_WORKER_TOKEN = "worker-token";
  return {
    privateR2Delete: vi.fn(),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({ task: (definition: unknown) => definition }));
vi.mock("../lib/private-r2", () => ({ privateR2Delete: mocks.privateR2Delete }));

import { runFileIngestDerivedCleanup } from "./file-ingest-cleanup";

function configureConvex(claim: unknown) {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
    calls.push({ path: body.path, args: body.args });
    const value = body.path === "files:claimIngestDerivedCleanup" ? claim : true;
    return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

describe("private ingest derived cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.privateR2Delete.mockResolvedValue(undefined);
  });

  it("deletes only the exact R2 keys claimed from the durable outbox", async () => {
    const calls = configureConvex({
      ready: true,
      r2Keys: [
        "owners/daniel/files/file-1/v1/extracted.txt",
        "owners/daniel/files/file-1/v1/preview.webp",
      ],
    });

    await expect(runFileIngestDerivedCleanup({ outboxId: "outbox-1" }))
      .resolves.toEqual({ outboxId: "outbox-1", deleted: true });

    expect(mocks.privateR2Delete).toHaveBeenNthCalledWith(1, "owners/daniel/files/file-1/v1/extracted.txt");
    expect(mocks.privateR2Delete).toHaveBeenNthCalledWith(2, "owners/daniel/files/file-1/v1/preview.webp");
    expect(calls).toEqual([
      expect.objectContaining({ path: "files:claimIngestDerivedCleanup" }),
      expect.objectContaining({ path: "files:finishIngestDerivedCleanup" }),
    ]);
  });

  it("does not delete when the cleanup claim observes a durable commit", async () => {
    const calls = configureConvex({ ready: false, committed: true });

    await expect(runFileIngestDerivedCleanup({ outboxId: "outbox-1" }))
      .resolves.toEqual({ outboxId: "outbox-1", skipped: true });

    expect(mocks.privateR2Delete).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
