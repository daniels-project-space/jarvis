import { describe, expect, it } from "vitest";
import { readyPrivateFilePanel } from "./private-file-panel";

describe("readyPrivateFilePanel", () => {
  it.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/webp", "image"],
    ["video/mp4", "private_video"],
    ["video/quicktime", "private_video"],
    ["video/webm", "private_video"],
    ["application/pdf", "private_pdf"],
  ] as const)("uses the dedicated safe renderer for ready %s", (mimeType, type) => {
    expect(readyPrivateFilePanel({
      fileId: "file/one",
      name: "trip\n walkthrough.mp4",
      mimeType,
      status: "ready",
    })).toMatchObject({
      type,
      value: "/api/files/file%2Fone",
      title: "trip walkthrough.mp4",
    });
  });

  it.each([
    { fileId: "file-1", mimeType: "video/mp4", status: "stored_only" },
    { fileId: "file-1", mimeType: "video/mp4", status: "processing" },
    { fileId: "file-1", mimeType: "audio/mpeg", status: "ready" },
    { fileId: "file-1", mimeType: "text/html", status: "ready" },
    { fileId: "", mimeType: "image/png", status: "ready" },
  ])("refuses any non-ready, unsupported, or malformed candidate", (file) => {
    expect(readyPrivateFilePanel(file)).toBeNull();
  });
});
