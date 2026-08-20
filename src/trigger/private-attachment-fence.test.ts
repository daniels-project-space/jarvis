import { describe, expect, it } from "vitest";
import {
  reconcileReadyClaimAttachments,
  resolveReadyClaimAttachments,
  samePrivateAttachmentSources,
  type PrivateClaimAttachment,
} from "./private-attachment-fence";

const claimed: PrivateClaimAttachment = {
  fileId: "file-1",
  name: "arrival.png",
  relativePath: "travel/arrival.png",
  mimeType: "image/png",
  sizeBytes: 42,
  status: "ready",
  selection: "recent_followup",
  r2Key: "owners/daniel/files/file-1/v1/original",
};

describe("private foreground attachment fence", () => {
  it("keeps only the exact still-ready claimed source and refreshes its private metadata", () => {
    const current = reconcileReadyClaimAttachments([claimed], [
      {
        ...claimed,
        status: "stored_only",
        r2Key: "owners/daniel/files/file-1/v2/original",
        previewR2Key: "owners/daniel/files/file-1/v2/preview.webp",
        selection: "message",
      },
      {
        ...claimed,
        fileId: "unclaimed-file",
        name: "other.png",
        r2Key: "owners/daniel/files/unclaimed-file/v1/original",
      },
    ]);

    expect(current).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        r2Key: "owners/daniel/files/file-1/v2/original",
        selection: "recent_followup",
      }),
    ]);
    expect(samePrivateAttachmentSources([claimed], current)).toBe(false);
  });

  it("fails closed when the source has been deleted, is deleting, or the authoritative read fails", async () => {
    await expect(resolveReadyClaimAttachments([claimed], async () => [
      { ...claimed, status: "deleting" },
    ])).resolves.toEqual([]);
    await expect(resolveReadyClaimAttachments([claimed], async () => {
      throw new Error("Convex unavailable");
    })).resolves.toEqual([]);
  });
});
