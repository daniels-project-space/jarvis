import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreationSourceFiles } from "./CreationSourceFiles";

const viewer = vi.hoisted(() => ({ token: "owner" as string | null }));

vi.mock("@/lib/viewer-session", () => ({
  useViewerSession: () => viewer.token,
  isGuestViewerSession: (token: string | null) => token === "guest",
}));

describe("creation source file provenance", () => {
  beforeEach(() => { viewer.token = "owner"; });

  it("renders bounded owner-only open and download links without storage coordinates", () => {
    const markup = renderToStaticMarkup(
      <CreationSourceFiles
        maxVisible={2}
        files={[
          { fileId: "file/one", name: "revenue.csv" },
          { fileId: "file-two", name: "brief.pdf" },
          { fileId: "file-three", name: "notes.docx" },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="3 source files"');
    expect(markup).toContain('aria-label="Open source revenue.csv"');
    expect(markup).toContain('href="/api/files/file%2Fone"');
    expect(markup).toContain('aria-label="Download source revenue.csv"');
    expect(markup).toContain('href="/api/files/file%2Fone?download=1"');
    expect(markup).toContain('aria-label="1 more source files"');
    expect(markup).not.toContain("owners/daniel");
    expect(markup).not.toContain("r2Key");
  });

  it("renders nothing for a guest or a creation without sources", () => {
    viewer.token = "guest";
    expect(renderToStaticMarkup(<CreationSourceFiles files={[{ fileId: "one", name: "private.csv" }]} />)).toBe("");
    viewer.token = "owner";
    expect(renderToStaticMarkup(<CreationSourceFiles files={[]} />)).toBe("");
  });
});
