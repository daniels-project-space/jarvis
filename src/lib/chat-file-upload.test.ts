import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_FILE_LIMITS } from "./chat-files";

const { viewerFetchWithTimeout } = vi.hoisted(() => ({ viewerFetchWithTimeout: vi.fn() }));
vi.mock("./viewer-request", () => ({ viewerFetchWithTimeout }));

import { filesFromDrop, uploadPrivateChatFiles } from "./chat-file-upload";

const sessionResponse = () => new Response(JSON.stringify({
  ok: true,
  batchId: "batch-1",
  files: [{ clientId: expect.any(String), fileId: "file-1", uploadUrl: "/api/files/upload/file-1", status: "reserved" }],
}), { status: 201, headers: { "content-type": "application/json" } });

describe("private chat-file upload client", () => {
  beforeEach(() => viewerFetchWithTimeout.mockReset());

  it("bounds reservation and file requests with the upload deadline", async () => {
    viewerFetchWithTimeout
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          ok: true,
          batchId: "batch-1",
          files: [{ clientId: body.files[0].clientId, fileId: "file-1", uploadUrl: "/api/files/upload/file-1", status: "reserved" }],
        }), { status: 201, headers: { "content-type": "application/json" } });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }));

    const ids = await uploadPrivateChatFiles([new File(["hello"], "hello.txt", { type: "text/plain" })], "main");

    expect(ids).toEqual(["file-1"]);
    expect(viewerFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(viewerFetchWithTimeout.mock.calls.every((call) => call[2] === CHAT_FILE_LIMITS.clientUploadTimeoutMs)).toBe(true);
  });

  it("uses the same bounded transport to cancel a partially failed batch", async () => {
    viewerFetchWithTimeout
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const response = sessionResponse();
        const payload = await response.json() as { files: Array<Record<string, unknown>> };
        payload.files[0].clientId = body.files[0].clientId;
        return new Response(JSON.stringify({ ...payload, ok: true, batchId: "batch-1" }), { status: 201 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "storage unavailable" }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(uploadPrivateChatFiles(
      [new File(["hello"], "hello.txt", { type: "text/plain" })],
      "main",
    )).rejects.toThrow("storage unavailable");

    expect(viewerFetchWithTimeout).toHaveBeenLastCalledWith(
      "/api/files/cancel-upload",
      expect.objectContaining({ method: "POST" }),
      CHAT_FILE_LIMITS.clientUploadTimeoutMs,
    );
  });

  it("cancels the durable batch when the user aborts an active file PUT", async () => {
    const controller = new AbortController();
    viewerFetchWithTimeout
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          ok: true,
          batchId: "batch-1",
          files: [{ clientId: body.files[0].clientId, fileId: "file-1", uploadUrl: "/api/files/upload/file-1", status: "reserved" }],
        }), { status: 201 });
      })
      .mockImplementationOnce(async () => {
        controller.abort(new DOMException("Upload cancelled", "AbortError"));
        throw controller.signal.reason;
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(uploadPrivateChatFiles(
      [new File(["hello"], "hello.txt", { type: "text/plain" })],
      "main",
      undefined,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(viewerFetchWithTimeout).toHaveBeenLastCalledWith(
      "/api/files/cancel-upload",
      expect.objectContaining({ method: "POST" }),
      CHAT_FILE_LIMITS.clientUploadTimeoutMs,
    );
  });

  it("keeps folder paths when drag-and-drop uses the legacy directory API", async () => {
    const entry = (name: string, body: string) => ({
      isFile: true as const,
      isDirectory: false as const,
      name,
      file: (success: (file: File) => void) => success(new File([body], name, { type: "text/plain" })),
    });
    const batches = [[entry("one.txt", "one"), entry("two.txt", "two")], []];
    const directory = {
      isFile: false as const,
      isDirectory: true as const,
      name: "reports",
      createReader: () => ({ readEntries: (success: (entries: unknown[]) => void) => success(batches.shift() ?? []) }),
    };
    const transfer = {
      items: [{ webkitGetAsEntry: () => directory, getAsFile: () => null }],
    } as unknown as DataTransfer;

    const files = await filesFromDrop(transfer);

    expect(files.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath)).toEqual([
      "reports/one.txt",
      "reports/two.txt",
    ]);
  });
});
