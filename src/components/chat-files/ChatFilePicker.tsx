"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { ChatFileManifest } from "@/lib/chat-files";
import { filesFromDrop, uploadFilesForChat, type UploadProgress } from "@/lib/chat-file-upload";
import { useJarvisQuery } from "@/lib/secure-convex";
import { ChatFileChip } from "./ChatFileChip";
import { ChatFileLibraryDropdown } from "./ChatFileLibraryDropdown";
import type { ChatFileNotice } from "./ChatFilePendingMonitor";

type FileIdSetter = (update: string[] | ((current: string[]) => string[])) => void;

export function ChatFilePicker({
  threadId,
  selectedFileIds,
  pendingFileIds,
  onSelectionChange,
  onPendingChange,
  notice,
  onNotice,
  disabled = false,
  onDropUpload,
}: {
  threadId: string;
  selectedFileIds: string[];
  pendingFileIds: string[];
  onSelectionChange: FileIdSetter;
  onPendingChange: FileIdSetter;
  notice: ChatFileNotice;
  onNotice: (notice: ChatFileNotice) => void;
  disabled?: boolean;
  /** Called with the fileIds from a drag-and-drop upload only (not the file/folder pickers), so callers can tell drop-triggered batches apart from deliberate picks. */
  onDropUpload?: (fileIds: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const uploadAbortRef = useRef<AbortController | null>(null);
  const threadFiles = useJarvisQuery(api.files.listForThread, { threadId, limit: 100 }) as ChatFileManifest[] | undefined;
  const byId = useMemo(() => new Map((threadFiles ?? []).map((file) => [file.fileId, file])), [threadFiles]);

  const upload = async (files: File[], fromDrop = false) => {
    if (!files.length || disabled || progress) return;
    setActionsOpen(true);
    setError("");
    onNotice(null);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    await uploadFilesForChat(files, threadId, {
      onPendingChange,
      onProgress: setProgress,
      signal: controller.signal,
      onUploaded: fromDrop ? onDropUpload : undefined,
      onOutcome: (outcome) => {
        if (outcome.kind === "cancelled") onNotice({ tone: "status", text: "Upload cancelled. Any reserved private storage is being cleaned up." });
        else setError(outcome.message);
      },
    });
    if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
  };

  const selectedFiles = selectedFileIds.map((fileId) => byId.get(fileId)).filter((file): file is ChatFileManifest => Boolean(file));
  const closeLibrary = useCallback(() => {
    setLibraryOpen(false);
    setActionsOpen(false);
    requestAnimationFrame(() => attachmentTriggerRef.current?.focus());
  }, []);
  const closeActions = useCallback(() => {
    setActionsOpen(false);
    setError("");
    onNotice(null);
    requestAnimationFrame(() => attachmentTriggerRef.current?.focus());
  }, [onNotice]);

  useEffect(() => {
    if (!actionsOpen) return;
    requestAnimationFrame(() => firstActionRef.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeActions();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen, closeActions]);

  const attachmentCount = selectedFileIds.length + pendingFileIds.length;
  const detailsOpen = actionsOpen || Boolean(progress) || Boolean(error) || Boolean(notice) || pendingFileIds.length > 0;
  const progressPercent = progress ? Math.round((progress.completed / Math.max(1, progress.total)) * 100) : 0;
  return (
    <div
      ref={rootRef}
      className={`relative shrink-0 self-stretch ${dragging ? "rounded-xl ring-1 ring-cyan/60" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDragLeave={(event) => { event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        void filesFromDrop(event.dataTransfer).then((files) => upload(files, true)).catch((caught) => setError(String(caught)));
      }}
    >
      <input ref={inputRef} hidden multiple type="file" onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <input
        ref={(node) => {
          folderRef.current = node;
          node?.setAttribute("webkitdirectory", "");
          node?.setAttribute("directory", "");
        }}
        hidden
        multiple
        type="file"
        onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }}
      />
      <button
        id="jarvis-attachment-trigger"
        ref={attachmentTriggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (libraryOpen) {
            setLibraryOpen(false);
            setActionsOpen(false);
            return;
          }
          setActionsOpen((open) => !open);
        }}
        aria-controls={libraryOpen ? "jarvis-file-library" : "jarvis-attachment-actions"}
        aria-expanded={detailsOpen || libraryOpen}
        aria-haspopup="dialog"
        aria-label={attachmentCount
          ? `Attachments: ${attachmentCount} selected or processing`
          : "Attach files, folders, or saved files"}
        title="Attach files, images, documents, folders, or saved private files"
        className={`relative grid h-9 w-9 place-items-center rounded-xl text-slate transition sm:h-10 sm:w-10 ${
          progress || pendingFileIds.length
            ? "bg-amber/15 text-amber ring-1 ring-amber/40"
            : attachmentCount
              ? "bg-cyan/15 text-cyan ring-1 ring-cyan/40"
              : "glass hover:text-cyan"
        } disabled:opacity-40`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.7 9.7a2 2 0 0 1-2.8-2.8l9-9" />
        </svg>
        {attachmentCount > 0 && (
          <span aria-hidden="true" className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-cyan px-1 text-[9px] font-bold leading-none text-[#031015] ring-2 ring-[#071017]">
            {attachmentCount}
          </span>
        )}
        {progress && <span aria-hidden="true" className="absolute inset-0 animate-pulse rounded-xl ring-1 ring-amber/70" />}
      </button>

      {detailsOpen && (
        <section
          id="jarvis-attachment-actions"
          role="dialog"
          aria-modal="false"
          aria-labelledby="jarvis-attachment-title"
          aria-busy={Boolean(progress || pendingFileIds.length)}
          className="absolute bottom-full left-0 z-[65] mb-2 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-white/12 bg-[#071017]/98 shadow-2xl shadow-black/60 backdrop-blur-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-white/8 px-3 py-2.5">
            <div>
              <h3 id="jarvis-attachment-title" className="text-xs font-medium text-white">Attach to this message</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">Private, durable, and available to Jarvis in this chat.</p>
            </div>
            {!progress && !pendingFileIds.length && (
              <button type="button" onClick={closeActions} aria-label="Close attachment options" className="grid size-9 shrink-0 place-items-center rounded-full text-lg text-slate-400 hover:bg-white/10 hover:text-white">×</button>
            )}
          </header>

          <div className="grid grid-cols-3 gap-1.5 p-2">
            <button ref={firstActionRef} type="button" disabled={disabled || Boolean(progress)} onClick={() => inputRef.current?.click()} className="min-h-14 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-2 text-[11px] text-slate-200 hover:border-cyan/30 hover:text-cyan disabled:opacity-40">
              <span aria-hidden="true" className="mb-1 block text-base">＋</span>Files & images
            </button>
            <button type="button" disabled={disabled || Boolean(progress)} onClick={() => folderRef.current?.click()} className="min-h-14 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-2 text-[11px] text-slate-200 hover:border-cyan/30 hover:text-cyan disabled:opacity-40">
              <span aria-hidden="true" className="mb-1 block text-base">▱</span>Folder
            </button>
            <button
              type="button"
              disabled={disabled || Boolean(progress)}
              onClick={() => {
                setActionsOpen(false);
                setLibraryOpen(true);
              }}
              className="min-h-14 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-2 text-[11px] text-slate-200 hover:border-cyan/30 hover:text-cyan disabled:opacity-40"
            >
              <span aria-hidden="true" className="mb-1 block text-base">▤</span>Saved files
            </button>
          </div>

          {progress && (
            <div className="border-t border-white/8 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <span role="status" aria-live="polite" className="min-w-0 truncate text-cyan">
                  {progress.phase} {progress.completed}/{progress.total} · {progress.fileName}
                </span>
                <button
                  type="button"
                  disabled={progress.phase === "cancelling"}
                  onClick={() => {
                    setProgress((current) => current ? { ...current, phase: "cancelling" } : current);
                    uploadAbortRef.current?.abort(new DOMException("Upload cancelled", "AbortError"));
                  }}
                  className="min-h-9 shrink-0 rounded-lg px-2 text-amber-300 hover:bg-amber-300/10 disabled:opacity-40"
                >
                  cancel
                </button>
              </div>
              <div role="progressbar" aria-label="File upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
                <span className="block h-full rounded-full bg-cyan transition-[width]" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {selectedFiles.length > 0 && (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto border-t border-white/8 px-3 py-2" aria-label="Files attached to this message">
              {selectedFiles.map((file) => <ChatFileChip key={file.fileId} file={file} onRemove={() => onSelectionChange((current) => current.filter((id) => id !== file.fileId))} />)}
            </div>
          )}
          {pendingFileIds.length > 0 && <p role="status" aria-live="polite" className="border-t border-white/8 px-3 py-2 text-[11px] text-amber-300">Jarvis is indexing {pendingFileIds.length} file{pendingFileIds.length === 1 ? "" : "s"}. Sending waits so they stay with this message.</p>}
          {notice && (
            <div className={`flex items-start justify-between gap-2 border-t border-white/8 px-3 py-2 text-[11px] ${notice.tone === "error" ? "text-red-300" : "text-cyan"}`}>
              <p role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>
              <button type="button" onClick={() => onNotice(null)} aria-label="Dismiss attachment notice" className="shrink-0 text-slate-400 hover:text-white">×</button>
            </div>
          )}
          {error && (
            <div className="flex items-start justify-between gap-2 border-t border-red-400/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
              <p role="alert">{error}</p>
              <button type="button" onClick={() => setError("")} aria-label="Dismiss attachment error" className="shrink-0 text-red-200/70 hover:text-white">×</button>
            </div>
          )}
          <footer className="border-t border-white/8 px-3 py-1.5 text-[9px] text-slate-500">4 MB per file · 40 files / 64 MB per batch · 8 per message</footer>
        </section>
      )}
      {dragging && <div className="pointer-events-none absolute bottom-full left-0 z-[66] mb-2 grid h-24 w-[min(22rem,calc(100vw-1rem))] place-items-center rounded-2xl border border-dashed border-cyan/60 bg-[#071017]/95 text-xs text-cyan">Drop files or a folder · 4 MB each</div>}
      {libraryOpen && (
        <ChatFileLibraryDropdown
          threadId={threadId}
          selectedFileIds={selectedFileIds}
          onSelectionChange={onSelectionChange}
          onFileDeleted={(fileId) => onPendingChange((current) => current.filter((id) => id !== fileId))}
          onClose={closeLibrary}
        />
      )}
    </div>
  );
}
