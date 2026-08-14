import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../convex/_generated/api", () => ({
  api: { files: { paginatedForThread: { _name: "files:paginatedForThread" }, paginatedLibrary: { _name: "files:paginatedLibrary" } } },
}));
vi.mock("@/lib/viewer-session", () => ({ useViewerSession: () => "owner.viewer.token" }));
vi.mock("@/lib/viewer-request", () => ({ viewerFetchWithTimeout: vi.fn() }));
vi.mock("@/lib/client-mutation", () => ({ clientMutation: vi.fn() }));
vi.mock("convex/react", () => ({
  usePaginatedQuery: (query: { _name?: string } | undefined) => query?._name === "files:paginatedForThread"
    ? {
        results: [
          { fileId: "file-1", name: "budget.csv", relativePath: "reports/budget.csv", mimeType: "text/csv", sizeBytes: 2_048, status: "ready", reviewState: "favorite" },
          { fileId: "file-2", name: "sunrise.webp", relativePath: "travel/sunrise.webp", mimeType: "image/webp", sizeBytes: 2_048, status: "ready", reviewState: "review_remove" },
          { fileId: "file-3", name: "flight.mp4", relativePath: "travel/flight.mp4", mimeType: "video/mp4", sizeBytes: 2_048, status: "stored_only" },
          { fileId: "file-4", name: "arrival.mp4", relativePath: "travel/arrival.mp4", mimeType: "video/mp4", sizeBytes: 2_048, status: "ready" },
          { fileId: "file-5", name: "itinerary.pdf", relativePath: "travel/itinerary.pdf", mimeType: "application/pdf", sizeBytes: 2_048, status: "ready" },
        ],
        status: "CanLoadMore",
        loadMore: vi.fn(),
      }
    : { results: [], status: "Exhausted", loadMore: vi.fn() },
}));

import { ChatFileLibraryDropdown, filterFilesByReviewState, readyPrivateImagePanel, readyPrivatePdfPanel, readyPrivateVideoPanel } from "./ChatFileLibraryDropdown";

describe("private file library accessibility", () => {
  it("creates a panel input only for a ready detected image, without exposing storage keys", () => {
    expect(readyPrivateImagePanel({
      fileId: "file/one",
      name: "sunrise.webp",
      relativePath: "travel/sunrise.webp",
      mimeType: "image/webp",
      status: "ready",
    })).toEqual({
      type: "image",
      value: "/api/files/file%2Fone",
      title: "travel/sunrise.webp",
    });
    expect(readyPrivateImagePanel({
      fileId: "file-2",
      name: "flight.mp4",
      relativePath: "travel/flight.mp4",
      mimeType: "video/mp4",
      status: "stored_only",
    })).toBeNull();
    expect(readyPrivateVideoPanel({
      fileId: "file/one",
      name: "arrival.mp4",
      relativePath: "travel/arrival.mp4",
      mimeType: "video/mp4",
      status: "ready",
    })).toEqual({
      type: "private_video",
      value: "/api/files/file%2Fone",
      title: "travel/arrival.mp4",
    });
    expect(readyPrivateVideoPanel({
      fileId: "file-3",
      name: "flight.mp4",
      relativePath: "travel/flight.mp4",
      mimeType: "video/mp4",
      status: "stored_only",
    })).toBeNull();
    expect(readyPrivateVideoPanel({
      fileId: "file-2",
      name: "sunrise.webp",
      relativePath: "travel/sunrise.webp",
      mimeType: "image/webp",
      status: "ready",
    })).toBeNull();
    expect(readyPrivatePdfPanel({
      fileId: "file/one",
      name: "itinerary.pdf",
      relativePath: "travel/itinerary.pdf",
      mimeType: "application/pdf",
      status: "ready",
    })).toEqual({
      type: "private_pdf",
      value: "/api/files/file%2Fone",
      title: "travel/itinerary.pdf",
    });
    expect(readyPrivatePdfPanel({
      fileId: "file-4",
      name: "arrival.mp4",
      relativePath: "travel/arrival.mp4",
      mimeType: "video/mp4",
      status: "ready",
    })).toBeNull();
  });

  it("renders an associated dialog, named reversible review actions, and cursor continuation", () => {
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
    expect(markup).toContain('aria-label="Show sunrise.webp in Jarvis"');
    expect(markup).toContain('aria-label="Show arrival.mp4 in Jarvis"');
    expect(markup).toContain('aria-label="Show itinerary.pdf in Jarvis"');
    expect(markup).not.toContain('aria-label="Show budget.csv in Jarvis"');
    expect(markup).not.toContain('aria-label="Show flight.mp4 in Jarvis"');
    expect(markup).toContain('aria-label="Remove favourite from budget.csv"');
    expect(markup).toContain('aria-label="Restore sunrise.webp from removal review"');
    expect(markup).not.toContain('aria-label="Delete budget.csv permanently"');
    expect(markup).toContain("Load more files");
    expect(markup).toContain("8 files per message");
    expect(markup).toContain("Review marks never delete files");
  });

  it("filters durable states without treating legacy rows as removal candidates", () => {
    const files = [
      { fileId: "favorite", name: "favorite.jpg", relativePath: "favorite.jpg", mimeType: "image/jpeg", sizeBytes: 1, status: "ready", reviewState: "favorite" as const },
      { fileId: "remove", name: "remove.jpg", relativePath: "remove.jpg", mimeType: "image/jpeg", sizeBytes: 1, status: "ready", reviewState: "review_remove" as const },
      { fileId: "legacy", name: "legacy.jpg", relativePath: "legacy.jpg", mimeType: "image/jpeg", sizeBytes: 1, status: "ready" },
    ];
    expect(filterFilesByReviewState(files, "favorite").map((file) => file.fileId)).toEqual(["favorite"]);
    expect(filterFilesByReviewState(files, "review_remove").map((file) => file.fileId)).toEqual(["remove"]);
    expect(filterFilesByReviewState(files, "all")).toHaveLength(3);
  });
});
