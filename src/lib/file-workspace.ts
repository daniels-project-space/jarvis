export type WorkspaceFile = {
  fileId: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  summary?: string;
  reviewState?: "unreviewed" | "favorite" | "review_remove";
  tags?: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceFolder = {
  path: string;
  name: string;
  depth: number;
  childFolders: string[];
  fileCount: number;
};

export type WorkspaceCollection = "all" | "recent" | "favorites" | "documents" | "media" | "attention";
export type WorkspaceSort = "updated" | "name" | "size" | "type";

export function parseFileWorkspaceIntent(text: string): { query?: string } | null {
  const clean = text.trim().replace(/[?!.]+$/g, "");
  const search = clean.match(/^(?:find|search(?: for)?|look for)\s+(.{1,80}?)\s+(?:in|across)\s+(?:my\s+)?(?:files?|documents?|file system|library)$/i);
  if (search) return { query: search[1].trim() };
  return /^(?:(?:please\s+)?(?:open|show|view|browse)\s+)?(?:my\s+)?(?:files?|documents?|file system|file workspace|document library)$/i.test(clean)
    ? {}
    : null;
}

export function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..").join("/");
}

export function workspaceFolderFor(file: WorkspaceFile): string {
  const path = normalizeWorkspacePath(file.relativePath || file.name);
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function buildWorkspaceFolders(files: WorkspaceFile[]): WorkspaceFolder[] {
  const folders = new Map<string, { files: number; children: Set<string> }>();
  folders.set("", { files: 0, children: new Set() });
  for (const file of files) {
    const folder = workspaceFolderFor(file);
    const parts = folder ? folder.split("/") : [];
    let parent = "";
    folders.get(parent)!.files += 1;
    for (const part of parts) {
      const path = parent ? `${parent}/${part}` : part;
      if (!folders.has(path)) folders.set(path, { files: 0, children: new Set() });
      folders.get(parent)!.children.add(path);
      folders.get(path)!.files += 1;
      parent = path;
    }
  }
  return [...folders.entries()].map(([path, value]) => ({
    path,
    name: path ? path.slice(path.lastIndexOf("/") + 1) : "All files",
    depth: path ? path.split("/").length : 0,
    childFolders: [...value.children].sort((a, b) => a.localeCompare(b)),
    fileCount: value.files,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

export function workspaceParentPath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const boundary = normalized.lastIndexOf("/");
  return boundary < 0 ? "" : normalized.slice(0, boundary);
}

export function workspaceFolderAncestors(path: string): string[] {
  const parts = normalizeWorkspacePath(path).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * The root is implicit. Top-level folders are always visible; deeper folders
 * are revealed only when every ancestor in their path is expanded.
 */
export function visibleWorkspaceFolders(
  folders: WorkspaceFolder[],
  expandedPaths: ReadonlySet<string>,
): WorkspaceFolder[] {
  return folders.filter((folder) => {
    if (!folder.path) return false;
    const ancestors = workspaceFolderAncestors(workspaceParentPath(folder.path));
    return ancestors.every((ancestor) => expandedPaths.has(ancestor));
  });
}

function isDocument(file: WorkspaceFile) {
  return /^(?:text\/|application\/(?:pdf|json|xml|yaml|x-yaml|msword|vnd\.openxmlformats-officedocument))/i.test(file.mimeType);
}

function isMedia(file: WorkspaceFile) {
  return /^(?:image|audio|video)\//i.test(file.mimeType);
}

export function workspaceCollectionMatches(file: WorkspaceFile, collection: WorkspaceCollection, now = Date.now()): boolean {
  if (collection === "recent") return now - file.updatedAt <= 14 * 24 * 60 * 60 * 1_000;
  if (collection === "favorites") return file.reviewState === "favorite";
  if (collection === "documents") return isDocument(file);
  if (collection === "media") return isMedia(file);
  if (collection === "attention") return file.reviewState === "review_remove" || file.status === "error" || file.status === "quarantined";
  return true;
}

export function visibleWorkspaceFiles(args: {
  files: WorkspaceFile[];
  folderPath: string;
  collection: WorkspaceCollection;
  query: string;
  sort: WorkspaceSort;
  now?: number;
}): WorkspaceFile[] {
  const folderPath = normalizeWorkspacePath(args.folderPath);
  const query = args.query.trim().toLowerCase();
  return args.files.filter((file) => {
    if (!workspaceCollectionMatches(file, args.collection, args.now)) return false;
    if (folderPath && workspaceFolderFor(file) !== folderPath) return false;
    if (!query) return true;
    return [file.name, file.relativePath, file.summary ?? "", ...(file.tags ?? [])].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => {
    if (args.sort === "name") return a.name.localeCompare(b.name);
    if (args.sort === "size") return b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name);
    if (args.sort === "type") return a.mimeType.localeCompare(b.mimeType) || a.name.localeCompare(b.name);
    return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);
  });
}

export function workspaceCollectionCounts(files: WorkspaceFile[], now = Date.now()): Record<WorkspaceCollection, number> {
  return {
    all: files.length,
    recent: files.filter((file) => workspaceCollectionMatches(file, "recent", now)).length,
    favorites: files.filter((file) => workspaceCollectionMatches(file, "favorites", now)).length,
    documents: files.filter((file) => workspaceCollectionMatches(file, "documents", now)).length,
    media: files.filter((file) => workspaceCollectionMatches(file, "media", now)).length,
    attention: files.filter((file) => workspaceCollectionMatches(file, "attention", now)).length,
  };
}
