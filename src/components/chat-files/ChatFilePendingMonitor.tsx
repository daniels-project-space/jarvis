"use client";

import { useEffect, useMemo, type RefObject } from "react";
import { api } from "../../../convex/_generated/api";
import type { ChatFileManifest } from "@/lib/chat-files";
import { useJarvisQuery } from "@/lib/secure-convex";
import { reconcilePendingFileSelection } from "./chat-file-pending";

export type ChatFileNotice = { tone: "status" | "error"; text: string } | null;

export function ChatFilePendingMonitor({
  threadId,
  pendingFileIds,
  selectedFileIds,
  onPendingChange,
  onSelectionChange,
  onNotice,
  autoSubmitFileIdsRef,
  onAutoSubmit,
}: {
  threadId: string;
  pendingFileIds: string[];
  selectedFileIds: string[];
  onPendingChange: (fileIds: string[]) => void;
  onSelectionChange: (fileIds: string[]) => void;
  onNotice: (notice: ChatFileNotice) => void;
  /** fileIds that came from a drag-and-drop upload, eligible for auto-submit once they attach. */
  autoSubmitFileIdsRef?: RefObject<Set<string>>;
  /** Called when a drop-triggered batch just attached and it's safe to send automatically. */
  onAutoSubmit?: () => void;
}) {
  const rows = useJarvisQuery(
    api.files.listForThread,
    pendingFileIds.length ? { threadId, limit: 100 } : "skip",
  ) as ChatFileManifest[] | undefined;
  const resolution = useMemo(
    () => rows ? reconcilePendingFileSelection(pendingFileIds, selectedFileIds, rows) : null,
    [pendingFileIds, rows, selectedFileIds],
  );

  useEffect(() => {
    if (!resolution) return;
    const settled = resolution.attached.length + resolution.failed.length + resolution.overflow.length;
    if (!settled) return;
    onSelectionChange(resolution.selectedFileIds);
    onPendingChange(resolution.pendingFileIds);
    if (resolution.failed.length) {
      const names = resolution.failed.slice(0, 2).map((file) => file.name).join(", ");
      onNotice({
        tone: "error",
        text: `${names}${resolution.failed.length > 2 ? ` and ${resolution.failed.length - 2} more` : ""} could not be indexed. Retry from Library.`,
      });
    } else if (resolution.overflow.length) {
      onNotice({
        tone: "status",
        text: `${resolution.selectedFileIds.length} files are attached. ${resolution.overflow.length} more ${resolution.overflow.length === 1 ? "is" : "are"} saved in Library.`,
      });
    } else {
      onNotice(null);
    }

    // Auto-context delivery: only for batches that came from a drop (tracked
    // via autoSubmitFileIdsRef, populated by useChatFileDropZone/ChatFilePicker's
    // own drop zone). Deliberate picks via the file/folder buttons or Library
    // never end up in that set, so they never auto-send. Ids are consumed here
    // regardless of outcome so a batch can only ever trigger this once.
    const dropSet = autoSubmitFileIdsRef?.current;
    if (dropSet && resolution.attached.length) {
      const eligible = resolution.attached.some((file) => dropSet.has(file.fileId));
      for (const file of resolution.attached) dropSet.delete(file.fileId);
      if (eligible) onAutoSubmit?.();
    }
  }, [autoSubmitFileIdsRef, onAutoSubmit, onNotice, onPendingChange, onSelectionChange, resolution]);

  return null;
}
