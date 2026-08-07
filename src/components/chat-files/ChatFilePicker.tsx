"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { ChatFileManifest } from "@/lib/chat-files";
import { filesFromDrop, uploadPrivateChatFiles, type UploadProgress } from "@/lib/chat-file-upload";
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
}: {
  threadId: string;
  selectedFileIds: string[];
  pendingFileIds: string[];
  onSelectionChange: FileIdSetter;
  onPendingChange: FileIdSetter;
  notice: ChatFileNotice;
  onNotice: (notice: ChatFileNotice) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const uploadAbortRef = useRef<AbortController | null>(null);
  const threadFiles = useJarvisQuery(api.files.listForThread, { threadId, limit: 100 }) as ChatFileManifest[] | undefined;
  const byId = useMemo(() => new Map((threadFiles ?? []).map((file) => [file.fileId, file])), [threadFiles]);

  const upload = async (files: File[]) => {
    if (!files.length || disabled || progress) return;
    setError("");
    onNotice(null);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      const fileIds = await uploadPrivateChatFiles(files, threadId, setProgress, controller.signal);
      onPendingChange((current) => [...new Set([...current, ...fileIds])]);
    } catch (caught) {
      const aborted = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
      if (aborted) onNotice({ tone: "status", text: "Upload cancelled. Any reserved private storage is being cleaned up." });
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setProgress(null);
    }
  };

  const selectedFiles = selectedFileIds.map((fileId) => byId.get(fileId)).filter((file): file is ChatFileManifest => Boolean(file));
  const closeLibrary = useCallback(() => {
    setLibraryOpen(false);
    requestAnimationFrame(() => libraryTriggerRef.current?.focus());
  }, []);
  return (
    <div
      className={`relative ${dragging ? "rounded-xl ring-1 ring-cyan/60" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void filesFromDrop(event.dataTransfer).then(upload).catch((caught) => setError(String(caught)));
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
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={disabled || Boolean(progress)} onClick={() => inputRef.current?.click()} className="min-h-10 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] text-slate-300 hover:border-cyan/30 hover:text-cyan disabled:opacity-40">＋ file</button>
        <button type="button" disabled={disabled || Boolean(progress)} onClick={() => folderRef.current?.click()} className="min-h-10 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] text-slate-300 hover:border-cyan/30 hover:text-cyan disabled:opacity-40">＋ folder</button>
        <button id="jarvis-file-library-trigger" ref={libraryTriggerRef} type="button" disabled={disabled} onClick={() => libraryOpen ? closeLibrary() : setLibraryOpen(true)} aria-controls="jarvis-file-library" aria-expanded={libraryOpen} aria-haspopup="dialog" className="min-h-10 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-[11px] text-slate-300 hover:border-cyan/30 hover:text-cyan disabled:opacity-40">library{selectedFileIds.length ? ` · ${selectedFileIds.length}` : ""}</button>
        {progress && <span role="status" className="ml-1 text-[10px] text-cyan">{progress.phase} {progress.completed}/{progress.total} · {progress.fileName}</span>}
        {progress && (
          <button
            type="button"
            disabled={progress.phase === "cancelling"}
            onClick={() => {
              setProgress((current) => current ? { ...current, phase: "cancelling" } : current);
              uploadAbortRef.current?.abort(new DOMException("Upload cancelled", "AbortError"));
            }}
            className="min-h-10 rounded-lg px-3 text-[11px] text-amber-300 hover:bg-amber-300/10 disabled:opacity-40"
          >
            cancel
          </button>
        )}
      </div>
      {selectedFiles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Files attached to this message">
          {selectedFiles.map((file) => <ChatFileChip key={file.fileId} file={file} onRemove={() => onSelectionChange((current) => current.filter((id) => id !== file.fileId))} />)}
        </div>
      )}
      {pendingFileIds.length > 0 && <p role="status" aria-live="polite" className="mt-1.5 text-[10px] text-amber-300">Jarvis is indexing {pendingFileIds.length} file{pendingFileIds.length === 1 ? "" : "s"}. Sending waits so they stay with this message.</p>}
      {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-1.5 max-w-md text-[10px] ${notice.tone === "error" ? "text-red-300" : "text-cyan"}`}>{notice.text}</p>}
      {error && <p role="alert" className="mt-1.5 max-w-md text-[10px] text-red-300">{error}</p>}
      {dragging && <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-xl border border-dashed border-cyan/60 bg-[#071017]/90 text-xs text-cyan">Drop files or a folder · 4 MB each</div>}
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
