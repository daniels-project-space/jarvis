"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { viewerFetchWithTimeout } from "@/lib/viewer-request";
import {
  buildWorkspaceFolders,
  visibleWorkspaceFiles,
  workspaceCollectionCounts,
  workspaceFolderFor,
  type WorkspaceCollection,
  type WorkspaceFile,
  type WorkspaceSort,
} from "@/lib/file-workspace";

const COLLECTIONS: Array<{ id: WorkspaceCollection; label: string; glyph: string }> = [
  { id: "all", label: "Folders", glyph: "⌂" },
  { id: "recent", label: "Recent", glyph: "◷" },
  { id: "favorites", label: "Favorites", glyph: "◇" },
  { id: "documents", label: "Documents", glyph: "▤" },
  { id: "media", label: "Media", glyph: "◉" },
  { id: "attention", label: "Attention", glyph: "!" },
];

function fileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function kindLabel(mime: string) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.includes("pdf")) return "PDF";
  if (mime.startsWith("text/") || /json|xml|yaml/.test(mime)) return "text";
  return "file";
}

function fileGlyph(mime: string) {
  if (mime.startsWith("image/")) return "◈";
  if (mime.startsWith("video/")) return "▶";
  if (mime.startsWith("audio/")) return "♪";
  if (mime.includes("pdf")) return "▧";
  if (mime.startsWith("text/") || /json|xml|yaml/.test(mime)) return "≡";
  return "◇";
}

type Draft = { editable: boolean; content?: string; version?: number; edited?: boolean };

export function FileWorkspace({ value = "" }: { value?: string }) {
  const source = useJarvisQuery(api.files.listLibrary, { limit: 100 }) as WorkspaceFile[] | undefined;
  return <FileWorkspaceView value={value} files={source} />;
}

export function FileWorkspaceView({ value = "", files: source }: { value?: string; files?: WorkspaceFile[] }) {
  const [fileOverrides, setFileOverrides] = useState<Record<string, WorkspaceFile | null>>({});
  const [collection, setCollection] = useState<WorkspaceCollection>("all");
  const [folderPath, setFolderPath] = useState("");
  const [query, setQuery] = useState(() => {
    try { return String(JSON.parse(value)?.query ?? "").slice(0, 120); } catch { return ""; }
  });
  const [sort, setSort] = useState<WorkspaceSort>("updated");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState("");
  const [movePath, setMovePath] = useState("");
  const [tags, setTags] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const storedSort = localStorage.getItem("jarvis_file_sort") as WorkspaceSort | null;
        const storedDensity = localStorage.getItem("jarvis_file_density") as "comfortable" | "compact" | null;
        if (["updated", "name", "size", "type"].includes(storedSort ?? "")) setSort(storedSort!);
        if (storedDensity === "compact" || storedDensity === "comfortable") setDensity(storedDensity);
      } catch { /* private browsing */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && draft) setDraft(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draft]);

  const localFiles = useMemo(() => (source ?? []).flatMap((file) => {
    const override = fileOverrides[file.fileId];
    return override === null ? [] : [override ?? file];
  }), [fileOverrides, source]);
  const folders = useMemo(() => buildWorkspaceFolders(localFiles), [localFiles]);
  const folderByPath = useMemo(() => new Map(folders.map((folder) => [folder.path, folder])), [folders]);
  const counts = useMemo(() => workspaceCollectionCounts(localFiles), [localFiles]);
  const visible = useMemo(() => visibleWorkspaceFiles({ files: localFiles, folderPath, collection, query, sort }), [collection, folderPath, localFiles, query, sort]);
  const childFolders = collection === "all" ? (folderByPath.get(folderPath)?.childFolders ?? []) : [];
  const focused = localFiles.find((file) => file.fileId === focusedId) ?? null;

  const focusFile = (file: WorkspaceFile) => {
    setFocusedId(file.fileId);
    setRename(file.name);
    setMovePath(workspaceFolderFor(file));
    setTags((file.tags ?? []).join(", "));
    setDraft(null);
  };

  const persistView = (nextSort: WorkspaceSort, nextDensity = density) => {
    setSort(nextSort);
    setDensity(nextDensity);
    try {
      localStorage.setItem("jarvis_file_sort", nextSort);
      localStorage.setItem("jarvis_file_density", nextDensity);
    } catch { /* private browsing */ }
  };

  const updateMetadata = async (file: WorkspaceFile, input: { name?: string; folderPath?: string; tags?: string[] }) => {
    setBusy(true);
    setNotice("");
    const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(file.fileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, 15_000).catch(() => null);
    const body = response ? await response.json().catch(() => null) as { file?: WorkspaceFile; error?: string } | null : null;
    setBusy(false);
    if (!response?.ok || !body?.file) return setNotice(body?.error ?? "That change was not saved.");
    setFileOverrides((current) => ({ ...current, [file.fileId]: body.file! }));
    setNotice("Saved.");
  };

  const moveSelected = async () => {
    const ids = selectedIds.length ? selectedIds : focused ? [focused.fileId] : [];
    if (!ids.length) return;
    for (const id of ids) {
      const file = localFiles.find((row) => row.fileId === id);
      if (file) await updateMetadata(file, { folderPath: movePath });
    }
    setSelectedIds([]);
  };

  const toggleFavorite = async (file: WorkspaceFile) => {
    setBusy(true);
    const reviewState = file.reviewState === "favorite" ? "unreviewed" : "favorite";
    const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(file.fileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewState }),
    }, 15_000).catch(() => null);
    setBusy(false);
    if (!response?.ok) return setNotice("The favourite state could not be saved.");
    setFileOverrides((current) => ({ ...current, [file.fileId]: { ...file, reviewState } }));
    setNotice(reviewState === "favorite" ? "Added to Favorites." : "Removed from Favorites.");
  };

  const removeSelected = async () => {
    const ids = selectedIds.length ? selectedIds : focused ? [focused.fileId] : [];
    if (!ids.length || !confirm(`Delete ${ids.length} private ${ids.length === 1 ? "file" : "files"} permanently? Files used by saved work will be protected.`)) return;
    setBusy(true);
    for (const id of ids) {
      const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }, 30_000).catch(() => null);
      if (response?.ok || response?.status === 202) setFileOverrides((current) => ({ ...current, [id]: null }));
      else setNotice("At least one file is protected or still being cleaned up.");
    }
    setSelectedIds([]);
    setFocusedId("");
    setBusy(false);
  };

  const loadEditor = async (file: WorkspaceFile) => {
    setBusy(true);
    const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(file.fileId)}?workspace=1`, { method: "GET" }, 15_000).catch(() => null);
    const body = response ? await response.json().catch(() => null) as Draft | null : null;
    setBusy(false);
    if (!response?.ok || !body) return setNotice("The document editor could not open this file.");
    if (!body.editable) return setNotice("This format opens in its original viewer and cannot be edited as text.");
    setDraft(body);
    setDraftText(body.content ?? "");
  };

  const saveDraft = async () => {
    if (!focused || !draft?.editable) return;
    setBusy(true);
    const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(focused.fileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: draftText, baseVersion: draft.version ?? 0 }),
    }, 20_000).catch(() => null);
    const body = response ? await response.json().catch(() => null) as { version?: number; error?: string } | null : null;
    setBusy(false);
    if (!response?.ok || typeof body?.version !== "number") return setNotice(body?.error ?? "The edit conflicted with another session. Reopen it before saving.");
    setDraft({ ...draft, edited: true, version: body.version, content: draftText });
    setNotice(`Saved version ${body.version}.`);
  };

  return (
    <div data-file-workspace className="relative flex min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_35%_0%,rgba(34,211,238,.08),transparent_38%)]">
      <aside className="hidden w-48 shrink-0 border-r border-white/[.07] bg-black/10 p-3 sm:block">
        <p className="mb-3 px-2 font-mono text-[8px] uppercase tracking-[.18em] text-cyan/70">Library</p>
        <nav className="space-y-1" aria-label="Smart file collections">
          {COLLECTIONS.map((item) => <button key={item.id} type="button" onClick={() => { setCollection(item.id); setFolderPath(""); }} className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[11px] transition ${collection === item.id ? "bg-cyan/10 text-cyan ring-1 ring-cyan/20" : "text-slate hover:bg-white/[.04] hover:text-ice"}`}><span className="w-4 text-center text-cyan/70">{item.glyph}</span><span className="flex-1">{item.label}</span><span className="font-mono text-[8px] opacity-60">{counts[item.id]}</span></button>)}
        </nav>
        <p className="mb-2 mt-5 px-2 font-mono text-[8px] uppercase tracking-[.18em] text-slate">Folders</p>
        <div className="max-h-[42vh] space-y-0.5 overflow-y-auto">
          {folders.filter((folder) => folder.path).map((folder) => <button key={folder.path} type="button" onClick={() => { setCollection("all"); setFolderPath(folder.path); }} className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[10px] ${folderPath === folder.path ? "bg-white/[.07] text-ice" : "text-slate hover:text-ice"}`} style={{ paddingLeft: `${8 + (folder.depth - 1) * 8}px` }}><span className="text-cyan/60">▹</span><span className="truncate">{folder.name}</span><span className="ml-auto font-mono text-[7px] opacity-50">{folder.fileCount}</span></button>)}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[.07] p-3">
          <button type="button" onClick={() => { const next = folderPath.includes("/") ? folderPath.slice(0, folderPath.lastIndexOf("/")) : ""; setFolderPath(next); setCollection("all"); }} disabled={!folderPath} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-slate disabled:opacity-25" aria-label="Parent folder">‹</button>
          <div className="min-w-[150px] flex-1"><p className="truncate text-xs text-ice">{collection === "all" ? folderPath || "All files" : COLLECTIONS.find((item) => item.id === collection)?.label}</p><p className="font-mono text-[7px] uppercase tracking-[.12em] text-slate">{visible.length} visible · {localFiles.length} indexed</p></div>
          <label className="flex h-8 min-w-[180px] flex-1 items-center rounded-full border border-white/10 bg-black/20 px-3 focus-within:border-cyan/35"><span className="mr-2 text-cyan/60">⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value.slice(0, 120))} placeholder="Find names, folders, text, tags" className="min-w-0 flex-1 bg-transparent text-[11px] text-ice outline-none placeholder:text-slate/60" /></label>
          <select value={sort} onChange={(event) => persistView(event.target.value as WorkspaceSort)} className="h-8 rounded-lg border border-white/10 bg-[#07131e] px-2 text-[9px] text-slate"><option value="updated">recent</option><option value="name">name</option><option value="size">size</option><option value="type">type</option></select>
          <button type="button" onClick={() => persistView(sort, density === "compact" ? "comfortable" : "compact")} className="h-8 rounded-lg border border-white/10 px-2 font-mono text-[8px] text-slate">{density === "compact" ? "roomy" : "compact"}</button>
        </div>

        {selectedIds.length > 0 && <div className="flex items-center gap-2 border-b border-cyan/15 bg-cyan/[.04] px-3 py-2 text-[10px] text-cyan"><span>{selectedIds.length} selected</span><input value={movePath} onChange={(event) => setMovePath(event.target.value)} placeholder="Folder/path" className="ml-auto h-7 min-w-0 rounded-lg border border-white/10 bg-black/20 px-2 text-ice outline-none" /><button type="button" disabled={busy} onClick={() => void moveSelected()} className="rounded-lg border border-cyan/20 px-2 py-1">move</button><button type="button" disabled={busy} onClick={() => void removeSelected()} className="rounded-lg border border-red-400/20 px-2 py-1 text-red-200">delete</button></div>}

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
          {childFolders.length > 0 && <section className="mb-4"><h2 className="mb-2 font-mono text-[8px] uppercase tracking-[.16em] text-slate">Folders</h2><div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">{childFolders.map((path) => { const folder = folderByPath.get(path)!; return <button key={path} type="button" onClick={() => setFolderPath(path)} className="group rounded-xl border border-white/[.07] bg-white/[.025] p-3 text-left transition hover:border-cyan/25 hover:bg-cyan/[.04]"><span className="text-cyan/60">▱</span><span className="ml-2 text-[11px] text-ice">{folder.name}</span><span className="mt-1 block font-mono text-[7px] text-slate">{folder.fileCount} items</span></button>; })}</div></section>}
          <section><h2 className="mb-2 font-mono text-[8px] uppercase tracking-[.16em] text-slate">Files</h2>{visible.length ? <div className={density === "compact" ? "space-y-1" : "grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3"}>{visible.map((file) => { const checked = selectedIds.includes(file.fileId); return <article key={file.fileId} className={`group flex min-w-0 items-center gap-2 rounded-xl border p-2.5 transition ${focusedId === file.fileId ? "border-cyan/40 bg-cyan/[.06]" : "border-white/[.07] bg-black/10 hover:border-white/15"}`}><input type="checkbox" checked={checked} onChange={() => setSelectedIds((current) => checked ? current.filter((id) => id !== file.fileId) : [...current, file.fileId])} aria-label={`Select ${file.name}`} className="accent-cyan" /><button type="button" onClick={() => focusFile(file)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[.04] text-cyan/70">{fileGlyph(file.mimeType)}</button><button type="button" onClick={() => focusFile(file)} className="min-w-0 flex-1 text-left"><span className="block truncate text-[11px] text-ice">{file.name}</span><span className="block truncate font-mono text-[7px] text-slate">{kindLabel(file.mimeType)} · {fileSize(file.sizeBytes)} · {workspaceFolderFor(file) || "root"}</span></button>{file.reviewState === "favorite" && <span title="Favorite" className="text-amber">◇</span>}</article>; })}</div> : <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-[11px] text-slate">No files here. Move a file into this folder or clear the search.</div>}</section>
        </div>
      </main>

      {focused && <aside className="absolute inset-x-2 bottom-2 z-20 max-h-[64%] overflow-y-auto rounded-2xl border border-cyan/20 bg-[#07131e]/[.98] p-3 shadow-2xl sm:static sm:inset-auto sm:max-h-none sm:w-64 sm:shrink-0 sm:rounded-none sm:border-y-0 sm:border-r-0 sm:border-l sm:bg-black/15 sm:shadow-none">
        <div className="mb-3 flex items-start gap-2"><div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan/[.07] text-cyan">{fileGlyph(focused.mimeType)}</div><div className="min-w-0 flex-1"><p className="truncate text-xs text-ice">{focused.name}</p><p className="font-mono text-[7px] text-slate">{kindLabel(focused.mimeType)} · {fileSize(focused.sizeBytes)}</p></div><button type="button" onClick={() => setFocusedId("")} className="text-slate">×</button></div>
        <label className="mb-2 block text-[9px] text-slate">Name<input value={rename} onChange={(event) => setRename(event.target.value)} className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-[11px] text-ice outline-none focus:border-cyan/35" /></label>
        <label className="mb-2 block text-[9px] text-slate">Folder<input value={movePath} onChange={(event) => setMovePath(event.target.value)} placeholder="Business/Project" className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-[11px] text-ice outline-none focus:border-cyan/35" /></label>
        <label className="mb-3 block text-[9px] text-slate">Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="important, client" className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-[11px] text-ice outline-none focus:border-cyan/35" /></label>
        <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => void updateMetadata(focused, { name: rename, folderPath: movePath, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) })} className="rounded-lg bg-cyan/10 px-2 py-2 text-[10px] text-cyan ring-1 ring-cyan/25">save details</button><a href={`/api/files/${encodeURIComponent(focused.fileId)}`} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 px-2 py-2 text-center text-[10px] text-slate">open original</a><button type="button" disabled={busy} onClick={() => void loadEditor(focused)} className="rounded-lg border border-white/10 px-2 py-2 text-[10px] text-slate">edit text</button><button type="button" disabled={busy} onClick={() => void toggleFavorite(focused)} className="rounded-lg border border-white/10 px-2 py-2 text-[10px] text-slate">{focused.reviewState === "favorite" ? "unfavorite" : "favorite"}</button></div>
        {focused.summary && <p className="mt-3 text-[10px] leading-relaxed text-slate">{focused.summary}</p>}
        {notice && <p role="status" className="mt-3 rounded-lg bg-white/[.04] px-2 py-1.5 text-[9px] text-cyan">{notice}</p>}
        <button type="button" disabled={busy} onClick={() => void removeSelected()} className="mt-4 text-[9px] text-red-300/70 hover:text-red-200">delete permanently…</button>
      </aside>}

      {draft?.editable && focused && <div className="absolute inset-2 z-40 flex flex-col overflow-hidden rounded-2xl border border-cyan/25 bg-[#050c13]/[.99] shadow-[0_30px_100px_rgba(0,0,0,.7)]"><header className="flex items-center gap-2 border-b border-white/10 px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-xs text-ice">{focused.name}</p><p className="font-mono text-[7px] uppercase tracking-[.12em] text-slate">editable draft · version {draft.version ?? 0} · immutable original preserved</p></div><button type="button" disabled={busy} onClick={() => void saveDraft()} className="rounded-lg bg-cyan/10 px-3 py-1.5 text-[10px] text-cyan ring-1 ring-cyan/25">save</button><button type="button" onClick={() => setDraft(null)} className="rounded-lg px-2 py-1.5 text-slate">×</button></header><textarea value={draftText} onChange={(event) => setDraftText(event.target.value.slice(0, 120_000))} spellCheck className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-relaxed text-ice outline-none" /><footer className="border-t border-white/[.07] px-3 py-1.5 text-right font-mono text-[7px] text-slate">{draftText.length.toLocaleString()} / 120,000</footer></div>}
    </div>
  );
}
