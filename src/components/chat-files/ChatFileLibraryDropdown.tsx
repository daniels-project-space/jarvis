"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { CHAT_FILE_LIMITS, type ChatFileManifest } from "@/lib/chat-files";
import { useViewerSession } from "@/lib/viewer-session";
import { viewerFetchWithTimeout } from "@/lib/viewer-request";

type LibraryFile = ChatFileManifest & { pinned?: boolean; updatedAt?: number };
type FileIdSetter = (update: string[] | ((current: string[]) => string[])) => void;

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden"));
}

export function ChatFileLibraryDropdown({
  threadId,
  selectedFileIds,
  onSelectionChange,
  onFileDeleted,
  onClose,
}: {
  threadId: string;
  selectedFileIds: string[];
  onSelectionChange: FileIdSetter;
  onFileDeleted: (fileId: string) => void;
  onClose: () => void;
}) {
  const viewerToken = useViewerSession();
  const [view, setView] = useState<"chat" | "all">("chat");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const busyRef = useRef(false);
  const popoverRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const allTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const threadPage = usePaginatedQuery(
    api.files.paginatedForThread,
    viewerToken && view === "chat" ? { threadId, search: debouncedSearch || undefined, viewerToken } : "skip",
    { initialNumItems: 32 },
  );
  const libraryPage = usePaginatedQuery(
    api.files.paginatedLibrary,
    viewerToken && view === "all" ? { search: debouncedSearch || undefined, viewerToken } : "skip",
    { initialNumItems: 32 },
  );
  const activePage = view === "chat" ? threadPage : libraryPage;
  const files = useMemo(() => {
    const seen = new Set<string>();
    return (activePage.results as LibraryFile[]).filter((file) => !seen.has(file.fileId) && Boolean(seen.add(file.fileId)));
  }, [activePage.results]);
  const selected = new Set(selectedFileIds);
  const actionBusy = Boolean(busyId);

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !popoverRef.current) return;
      const focusable = focusableElements(popoverRef.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const switchTab = (next: "chat" | "all") => {
    setView(next);
    setError("");
    requestAnimationFrame(() => (next === "chat" ? chatTabRef : allTabRef).current?.focus());
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "ArrowLeft" || event.key === "Home" ? "chat" : "all";
    switchTab(next);
  };

  const toggle = async (file: LibraryFile) => {
    if (!["ready", "stored_only"].includes(file.status) || busyRef.current) return;
    if (selected.has(file.fileId)) {
      onSelectionChange((current) => current.filter((id) => id !== file.fileId));
      return;
    }
    if (selectedFileIds.length >= CHAT_FILE_LIMITS.maxFilesPerMessage) {
      setError(`A message can use up to ${CHAT_FILE_LIMITS.maxFilesPerMessage} files. Remove one before adding ${file.name}.`);
      return;
    }
    setError("");
    if (view === "all") {
      busyRef.current = true;
      setBusyId(file.fileId);
      try {
        const response = await viewerFetchWithTimeout("/api/files/link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileId: file.fileId, threadId }),
        }, 15_000);
        if (!response.ok) throw new Error(`${file.name} could not be added to this chat.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : `${file.name} could not be added to this chat.`);
        return;
      } finally {
        busyRef.current = false;
        setBusyId("");
      }
    }
    onSelectionChange((current) => current.includes(file.fileId) || current.length >= CHAT_FILE_LIMITS.maxFilesPerMessage
      ? current
      : [...current, file.fileId]);
  };

  const retry = async (file: LibraryFile) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(file.fileId);
    setError("");
    try {
      const response = await viewerFetchWithTimeout("/api/files/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: file.fileId }),
      }, 15_000);
      if (!response.ok) throw new Error(`${file.name} could not be retried.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This file could not be retried.");
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const remove = async (file: LibraryFile) => {
    if (busyRef.current || !window.confirm(`Delete ${file.name} from Jarvis private storage?`)) return;
    busyRef.current = true;
    setBusyId(file.fileId);
    setError("");
    try {
      const response = await viewerFetchWithTimeout(`/api/files/${encodeURIComponent(file.fileId)}`, { method: "DELETE" }, 15_000);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(String(payload?.error ?? "The file could not be deleted."));
      }
      if (selected.has(file.fileId)) onSelectionChange((current) => current.filter((id) => id !== file.fileId));
      onFileDeleted(file.fileId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be deleted.");
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const loadingFirstPage = activePage.status === "LoadingFirstPage";
  const loadingMore = activePage.status === "LoadingMore";

  return (
    <section
      id="jarvis-file-library"
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="jarvis-file-library-title"
      aria-describedby="jarvis-file-library-description"
      aria-busy={loadingFirstPage || loadingMore}
      className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-50 flex max-h-[min(31rem,65dvh)] w-auto flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#071017]/98 shadow-2xl shadow-black/60 backdrop-blur-xl sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-3 sm:max-h-[min(31rem,70vh)] sm:w-[min(28rem,calc(100vw-2rem))]"
    >
      <header className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div>
          <h3 id="jarvis-file-library-title" className="text-sm font-medium text-white">Private files</h3>
          <p id="jarvis-file-library-description" className="mt-0.5 text-[11px] text-slate-400">Choose only what Jarvis may use in this message.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close file library" className="grid size-11 place-items-center rounded-full text-xl text-slate-400 hover:bg-white/10 hover:text-white">×</button>
      </header>
      <div className="border-b border-white/8 px-3 py-2.5">
        <div className="mb-2 flex rounded-lg bg-white/[0.035] p-0.5" role="tablist" aria-label="File library view">
          <button id="jarvis-file-tab-chat" ref={chatTabRef} type="button" role="tab" aria-controls="jarvis-file-results" aria-selected={view === "chat"} tabIndex={view === "chat" ? 0 : -1} onKeyDown={onTabKeyDown} onClick={() => switchTab("chat")} className={`min-h-10 flex-1 rounded-md px-2 py-1.5 text-[11px] ${view === "chat" ? "bg-white/10 text-white" : "text-slate-400"}`}>This chat</button>
          <button id="jarvis-file-tab-all" ref={allTabRef} type="button" role="tab" aria-controls="jarvis-file-results" aria-selected={view === "all"} tabIndex={view === "all" ? 0 : -1} onKeyDown={onTabKeyDown} onClick={() => switchTab("all")} className={`min-h-10 flex-1 rounded-md px-2 py-1.5 text-[11px] ${view === "all" ? "bg-white/10 text-white" : "text-slate-400"}`}>All files</button>
        </div>
        <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} type="search" aria-label={`Search ${view === "chat" ? "this chat" : "all private files"}`} placeholder="Search files…" className="min-h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none placeholder:text-slate-500 focus:border-cyan/40" />
      </div>
      {error && <p role="alert" className="mx-3 mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
      <div id="jarvis-file-results" role="tabpanel" aria-labelledby={view === "chat" ? "jarvis-file-tab-chat" : "jarvis-file-tab-all"} className="min-h-0 flex-1 overflow-y-auto p-2">
        {loadingFirstPage && <p role="status" className="px-3 py-8 text-center text-xs text-cyan">Loading private files…</p>}
        {!loadingFirstPage && !files.length && (
          <p className="px-3 py-8 text-center text-xs text-slate-400">{debouncedSearch ? "No files match this search." : "No private files yet. Add a file or folder from the chat composer."}</p>
        )}
        {files.map((file) => {
          const ready = file.status === "ready" || file.status === "stored_only";
          const retryable = file.status === "error";
          return (
            <div key={file.fileId} className="group flex min-h-14 items-center gap-2 rounded-xl px-2 py-2 hover:bg-white/[0.045] sm:gap-3 sm:px-3">
              <button
                type="button"
                disabled={!ready || actionBusy}
                onClick={() => void toggle(file)}
                aria-label={`${selected.has(file.fileId) ? "Remove" : "Attach"} ${file.name}`}
                aria-pressed={selected.has(file.fileId)}
                className={`grid size-10 shrink-0 place-items-center rounded-lg border text-sm sm:size-9 ${selected.has(file.fileId) ? "border-cyan bg-cyan text-black" : "border-white/20 text-transparent"} disabled:opacity-30`}
              >
                ✓
              </button>
              <button type="button" disabled={!ready || actionBusy} onClick={() => void toggle(file)} className="min-h-11 min-w-0 flex-1 text-left disabled:cursor-default">
                <span className="block truncate text-xs text-slate-100">{file.relativePath || file.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-400">{fileSize(file.sizeBytes)} · {file.status}{file.summary ? ` · ${file.summary}` : ""}</span>
              </button>
              {ready && (
                <a href={`/api/files/${encodeURIComponent(file.fileId)}`} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`} className="grid size-10 shrink-0 place-items-center rounded-lg text-sm text-slate-400 hover:bg-white/8 hover:text-cyan">↗</a>
              )}
              {retryable && (
                <button type="button" disabled={actionBusy} onClick={() => void retry(file)} aria-label={`Retry ${file.name}`} className="min-h-10 rounded-lg px-2 text-[10px] text-amber-300 hover:bg-amber-300/10 disabled:opacity-40">retry</button>
              )}
              <button type="button" disabled={actionBusy} onClick={() => void remove(file)} aria-label={`Delete ${file.name}`} className="grid size-10 shrink-0 place-items-center rounded-lg text-sm text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40">⌫</button>
            </div>
          );
        })}
        {(activePage.status === "CanLoadMore" || loadingMore) && (
          <button type="button" disabled={loadingMore} onClick={() => activePage.loadMore(32)} className="mt-2 min-h-11 w-full rounded-lg border border-cyan/20 px-3 py-2 text-xs text-cyan hover:bg-cyan/8 disabled:opacity-50">
            {loadingMore ? "Loading more files…" : "Load more files"}
          </button>
        )}
      </div>
      <footer className="border-t border-white/8 px-4 py-2 text-[10px] text-slate-400">4 MB per file · 40 files / 64 MB per batch · 8 files per message</footer>
    </section>
  );
}
