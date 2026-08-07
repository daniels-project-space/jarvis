import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../convex/_generated/api", () => ({
  api: { files: { paginatedForThread: { _name: "files:paginatedForThread" }, paginatedLibrary: { _name: "files:paginatedLibrary" } } },
}));
vi.mock("@/lib/viewer-session", () => ({ useViewerSession: () => "owner.viewer.token" }));
vi.mock("@/lib/viewer-request", () => ({ viewerFetchWithTimeout: vi.fn() }));
vi.mock("convex/react", () => ({
  usePaginatedQuery: (query: { _name?: string } | undefined) => query?._name === "files:paginatedForThread"
    ? {
        results: [{ fileId: "file-1", name: "budget.csv", relativePath: "reports/budget.csv", mimeType: "text/csv", sizeBytes: 2_048, status: "ready" }],
        status: "CanLoadMore",
        loadMore: vi.fn(),
      }
    : { results: [], status: "Exhausted", loadMore: vi.fn() },
}));

import { ChatFileLibraryDropdown } from "./ChatFileLibraryDropdown";

describe("private file library accessibility", () => {
  it("renders an associated dialog, named file actions, and cursor continuation", () => {
    const markup = renderToStaticMarkup(
      <ChatFileLibraryDropdown
        threadId="main"
        selectedFileIds={[]}
        onSelectionChange={vi.fn()}
        onFileDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="jarvis-file-library-title"');
    expect(markup).toContain('aria-label="Attach budget.csv"');
    expect(markup).toContain('aria-label="Open budget.csv"');
    expect(markup).toContain('aria-label="Delete budget.csv"');
    expect(markup).toContain("Load more files");
    expect(markup).toContain("8 files per message");
  });
});
