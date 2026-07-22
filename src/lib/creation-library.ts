export type CreationLibraryFilter = {
  kind: string | null;
  folder: string | null;
};

/** Read the routed library filter without carrying state from a prior file view. */
export function creationLibraryFilter(value: string): CreationLibraryFilter {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return { kind: null, folder: null };
    const { kind, folder } = parsed as { kind?: unknown; folder?: unknown };
    return {
      kind: typeof kind === "string" && kind.trim() ? kind : null,
      folder: typeof folder === "string" && folder.trim() ? folder : null,
    };
  } catch {
    return { kind: null, folder: null };
  }
}
