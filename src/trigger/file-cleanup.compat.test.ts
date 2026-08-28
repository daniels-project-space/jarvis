import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ privateR2Delete: vi.fn() }));

vi.mock("@trigger.dev/sdk/v3", () => ({ task: (definition: unknown) => definition }));
vi.mock("../lib/private-r2", () => ({ privateR2Delete: mock.privateR2Delete }));

import { fileCleanup } from "./file-cleanup";

const WORKER = "legacy-file-cleanup-test-worker";

function response(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

describe("legacy private file cleanup compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JARVIS_WORKER_TOKEN = WORKER;
    mock.privateR2Delete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.JARVIS_WORKER_TOKEN;
    vi.unstubAllGlobals();
  });

  it("continues using its unchanged files contract after the additive creation-asset schema rollout", async () => {
    const key = "owners/daniel/files/file-1/v1/original";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ value: { ready: true, r2Keys: [key] } }))
      .mockResolvedValueOnce(response({ value: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((fileCleanup as any).run({ fileId: "file-1" })).resolves.toEqual({ fileId: "file-1", deleted: true });

    expect(mock.privateR2Delete).toHaveBeenCalledWith(key);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      path: "files:claimCancelledUploadCleanup",
      args: { fileId: "file-1", workerToken: WORKER },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      path: "files:finishDelete",
      args: { fileId: "file-1", workerToken: WORKER },
    });
  });
});
