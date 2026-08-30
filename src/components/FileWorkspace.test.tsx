import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileWorkspaceView } from "./FileWorkspace";

describe("FileWorkspaceView", () => {
  it("renders one quiet real hierarchy with smart collections and file controls", () => {
    const markup = renderToStaticMarkup(<FileWorkspaceView files={[
      { fileId: "f1", name: "brief.md", relativePath: "Acme/Launch/brief.md", mimeType: "text/markdown", sizeBytes: 1024, status: "ready", summary: "Launch brief", tags: ["launch"], reviewState: "favorite", createdAt: 1, updatedAt: 2 },
      { fileId: "f2", name: "logo.png", relativePath: "Acme/logo.png", mimeType: "image/png", sizeBytes: 2048, status: "ready", reviewState: "unreviewed", createdAt: 1, updatedAt: 1 },
    ]} />);
    expect(markup).toContain("data-file-workspace");
    expect(markup).toContain("Smart file collections");
    expect(markup).toContain("Acme");
    expect(markup).toContain("brief.md");
    expect(markup).toContain("Find names, folders, text, tags");
    expect(markup).toContain("compact");
    expect(markup).toContain('data-file-folder="Acme"');
    expect(markup).toContain('draggable="true"');
  });
});
