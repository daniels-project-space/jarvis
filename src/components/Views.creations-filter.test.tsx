import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { creations: { list: { _name: "creations:list" } } },
}));
vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: () => [
    { _id: "doc-1", kind: "doc", title: "Project brief", category: "documents", folder: "Library / General", updatedAt: 1 },
    { _id: "image-1", kind: "image", title: "Campaign image", category: "images", folder: "Library / General", updatedAt: 1 },
  ],
}));
vi.mock("@/lib/client-mutation", () => ({ clientMutation: vi.fn() }));
vi.mock("@/lib/viewer-request", () => ({ viewerFetch: vi.fn() }));

import { CreationsView, filterCreationRows, type CreationRow } from "./Views";

describe("CreationsView category filters", () => {
  it("honors a category supplied by a focused Documents entry point", () => {
    const markup = renderToStaticMarkup(<CreationsView value={JSON.stringify({ category: "documents" })} />);

    expect(markup).toContain("Project brief");
    expect(markup).not.toContain("Campaign image");
    expect(markup).toContain("Clear documents filter");
  });

  it("honors the focused search supplied by the orb result's Show action", () => {
    const markup = renderToStaticMarkup(<CreationsView value={JSON.stringify({ folder: "Library / General", search: "brief" })} />);

    expect(markup).toContain("Project brief");
    expect(markup).not.toContain("Campaign image");
  });

  it("recomputes the visible rows when the Documents category is cleared", () => {
    const rows: CreationRow[] = [
      { _id: "doc-1", kind: "doc", title: "Project brief", category: "documents", folder: "Library / General", updatedAt: 1 },
      { _id: "image-1", kind: "image", title: "Campaign image", category: "images", folder: "Library / General", updatedAt: 1 },
    ];
    const documents = filterCreationRows(rows, { kind: null, category: "documents", folder: null, search: "" });
    const cleared = filterCreationRows(rows, { kind: null, category: null, folder: null, search: "" });

    expect(documents.map((row) => row._id)).toEqual(["doc-1"]);
    expect(cleared.map((row) => row._id)).toEqual(["doc-1", "image-1"]);
  });
});
