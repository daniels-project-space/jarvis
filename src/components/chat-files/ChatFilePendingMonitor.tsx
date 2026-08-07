"use client";

import { useEffect, useMemo } from "react";
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
}: {
  threadId: string;
  pendingFileIds: string[];
  selectedFileIds: string[];
  onPendingChange: (fileIds: string[]) => void;
  onSelectionChange: (fileIds: string[]) => void;
  onNotice: (notice: ChatFileNotice) => void;
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
  }, [onNotice, onPendingChange, onSelectionChange, resolution]);

  return null;
}
