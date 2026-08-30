import { describe, expect, it } from "vitest";
import {
  buildWorkspaceFolders,
  parseFileWorkspaceIntent,
  visibleWorkspaceFiles,
  visibleWorkspaceFolders,
  workspaceCollectionCounts,
  workspaceFolderAncestors,
  workspaceParentPath,
  type WorkspaceFile,
} from "./file-workspace";

const files: WorkspaceFile[] = [
  { fileId: "a", name: "plan.md", relativePath: "Acme/Launch/plan.md", mimeType: "text/markdown", sizeBytes: 10, status: "ready", tags: ["launch"], reviewState: "favorite", createdAt: 1, updatedAt: 100 },
  { fileId: "b", name: "logo.png", relativePath: "Acme/logo.png", mimeType: "image/png", sizeBytes: 20, status: "ready", reviewState: "unreviewed", createdAt: 2, updatedAt: 90 },
  { fileId: "c", name: "old.txt", relativePath: "old.txt", mimeType: "text/plain", sizeBytes: 5, status: "error", reviewState: "unreviewed", createdAt: 3, updatedAt: 1 },
];

describe("file workspace hierarchy", () => {
  it("builds a real nested folder tree with aggregate counts", () => {
    const folders = buildWorkspaceFolders(files);
    expect(folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "", fileCount: 3, childFolders: ["Acme"] }),
      expect.objectContaining({ path: "Acme", fileCount: 2, childFolders: ["Acme/Launch"] }),
      expect.objectContaining({ path: "Acme/Launch", fileCount: 1 }),
    ]));
    expect(visibleWorkspaceFolders(folders, new Set())).toEqual([
      expect.objectContaining({ path: "Acme" }),
    ]);
    expect(visibleWorkspaceFolders(folders, new Set(["Acme"]))).toEqual([
      expect.objectContaining({ path: "Acme" }),
      expect.objectContaining({ path: "Acme/Launch" }),
    ]);
    expect(workspaceParentPath("Acme / Launch / Assets")).toBe("Acme/Launch");
    expect(workspaceFolderAncestors("Acme/Launch/Assets")).toEqual(["Acme", "Acme/Launch", "Acme/Launch/Assets"]);
  });

  it("filters folders, smart collections, tags, and stable sorting", () => {
    expect(visibleWorkspaceFiles({ files, folderPath: "Acme/Launch", collection: "all", query: "launch", sort: "name" }).map((file) => file.fileId)).toEqual(["a"]);
    expect(workspaceCollectionCounts(files, 14 * 24 * 60 * 60 * 1_000 + 100).favorites).toBe(1);
    expect(workspaceCollectionCounts(files).attention).toBe(1);
  });

  it("recognizes only direct local file-workspace requests", () => {
    expect(parseFileWorkspaceIntent("open my file system")).toEqual({});
    expect(parseFileWorkspaceIntent("find launch plan in my files")).toEqual({ query: "launch plan" });
    expect(parseFileWorkspaceIntent("explain this document")).toBeNull();
  });
});
