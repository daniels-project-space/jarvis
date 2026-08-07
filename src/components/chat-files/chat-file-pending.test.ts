import { describe, expect, it } from "vitest";
import type { ChatFileManifest } from "@/lib/chat-files";
import { reconcilePendingFileSelection } from "./chat-file-pending";

const file = (index: number, status: string): ChatFileManifest => ({
  fileId: `file-${index}`,
  name: `file-${index}.txt`,
  relativePath: `folder/file-${index}.txt`,
  mimeType: "text/plain",
  sizeBytes: 20,
  status,
});

describe("pending chat-file selection", () => {
  it("keeps processing and not-yet-visible rows bound to the pending message", () => {
    const resolution = reconcilePendingFileSelection(
      ["file-1", "file-not-reactive-yet"],
      [],
      [file(1, "processing")],
    );

    expect(resolution.pendingFileIds).toEqual(["file-1", "file-not-reactive-yet"]);
    expect(resolution.selectedFileIds).toEqual([]);
  });

  it("attaches ready rows and removes terminal failures from pending", () => {
    const resolution = reconcilePendingFileSelection(
      ["file-1", "file-2", "file-3"],
      ["existing"],
      [file(1, "ready"), file(2, "stored_only"), file(3, "error")],
    );

    expect(resolution.selectedFileIds).toEqual(["existing", "file-1", "file-2"]);
    expect(resolution.pendingFileIds).toEqual([]);
    expect(resolution.failed.map((row) => row.fileId)).toEqual(["file-3"]);
  });

  it("never silently attaches folder overflow to a later message", () => {
    const rows = Array.from({ length: 40 }, (_, index) => file(index, "ready"));
    const resolution = reconcilePendingFileSelection(rows.map((row) => row.fileId), [], rows);

    expect(resolution.selectedFileIds).toHaveLength(8);
    expect(resolution.pendingFileIds).toEqual([]);
    expect(resolution.overflow).toHaveLength(32);
  });
});
