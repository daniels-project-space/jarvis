"use client";

import { useCallback, useState, type DragEvent } from "react";
import { filesFromDrop, uploadFilesForChat, type ChatFileUploadOutcome } from "@/lib/chat-file-upload";

type FileIdSetter = (update: string[] | ((current: string[]) => string[])) => void;
type ChatFileDropNotice = { tone: "status" | "error"; text: string } | null;

/**
 * Widened drag-and-drop zone shared by every "outer" composer wrapper in
 * JarvisUI (the full embedded chat, the standalone chat, the collapsed embed
 * widget). It reuses `uploadFilesForChat` — the exact same upload path
 * ChatFilePicker's own small drop zone calls — so a drop anywhere behaves
 * identically no matter which zone catches it.
 *
 * Plain-text drops (e.g. dragging selected text) are routed to `onTextDrop`
 * instead of being treated as a file upload.
 */
export function useChatFileDropZone({
  threadId,
  disabled = false,
  onPendingChange,
  onNotice,
  onTextDrop,
  onUploaded,
}: {
  threadId: string;
  disabled?: boolean;
  onPendingChange: FileIdSetter;
  onNotice: (notice: ChatFileDropNotice) => void;
  onTextDrop?: (text: string) => void;
  onUploaded?: (fileIds: string[]) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const reportOutcome = useCallback((outcome: ChatFileUploadOutcome) => {
    onNotice(
      outcome.kind === "cancelled"
        ? { tone: "status", text: "Upload cancelled. Any reserved private storage is being cleaned up." }
        : { tone: "error", text: outcome.message },
    );
  }, [onNotice]);

  const onDragEnter = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    setDragging(true);
  }, [disabled]);

  const onDragOver = useCallback((event: DragEvent) => {
    if (disabled) return;
    event.preventDefault();
  }, [disabled]);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }, []);

  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    if (event.dataTransfer.files.length === 0) {
      const text = event.dataTransfer.getData("text/plain").trim();
      if (text) {
        onTextDrop?.(text);
        return;
      }
    }
    onNotice(null);
    void filesFromDrop(event.dataTransfer)
      .then((files) => uploadFilesForChat(files, threadId, { onPendingChange, onOutcome: reportOutcome, onUploaded }))
      .catch((caught) => reportOutcome({ kind: "error", message: caught instanceof Error ? caught.message : String(caught) }));
  }, [disabled, threadId, onPendingChange, onTextDrop, onNotice, reportOutcome, onUploaded]);

  return { dragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
