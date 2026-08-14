import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatFileChip } from "./ChatFileChip";

describe("ChatFileChip", () => {
  it("does not present a stored-only private media file as analyzed", () => {
    const markup = renderToStaticMarkup(
      <ChatFileChip file={{
        fileId: "file-1",
        name: "clip.mp4",
        relativePath: "travel/clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 2_048,
        status: "stored_only",
      }} />,
    );

    expect(markup).toContain("saved only");
    expect(markup).not.toContain("processing");
  });

  it("keeps indexed files quiet", () => {
    const markup = renderToStaticMarkup(
      <ChatFileChip file={{
        fileId: "file-2",
        name: "notes.txt",
        relativePath: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 32,
        status: "ready",
      }} />,
    );

    expect(markup).not.toContain("saved only");
    expect(markup).not.toContain("processing");
  });
});
