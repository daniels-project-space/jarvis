import { CHAT_FILE_LIMITS, type ChatFileManifest } from "@/lib/chat-files";

const READY = new Set(["ready", "stored_only"]);
const FAILED = new Set(["error", "quarantined", "deleted"]);

export type PendingFileResolution = {
  selectedFileIds: string[];
  pendingFileIds: string[];
  attached: ChatFileManifest[];
  failed: ChatFileManifest[];
  overflow: ChatFileManifest[];
};

/**
 * Resolve only statuses that are terminal. Missing rows remain pending because
 * the upload reservation and the reactive thread query may arrive in either
 * order. A direct delete action explicitly removes its id at the UI boundary.
 */
export function reconcilePendingFileSelection(
  pendingFileIds: string[],
  selectedFileIds: string[],
  files: ChatFileManifest[],
): PendingFileResolution {
  const byId = new Map(files.map((file) => [file.fileId, file]));
  const selected = [...new Set(selectedFileIds)].slice(0, CHAT_FILE_LIMITS.maxFilesPerMessage);
  const selectedSet = new Set(selected);
  const attached: ChatFileManifest[] = [];
  const failed: ChatFileManifest[] = [];
  const overflow: ChatFileManifest[] = [];
  const pending: string[] = [];

  for (const fileId of [...new Set(pendingFileIds)]) {
    const file = byId.get(fileId);
    if (!file) {
      pending.push(fileId);
      continue;
    }
    if (FAILED.has(file.status)) {
      failed.push(file);
      continue;
    }
    if (!READY.has(file.status)) {
      pending.push(fileId);
      continue;
    }
    if (selectedSet.has(fileId)) continue;
    if (selected.length < CHAT_FILE_LIMITS.maxFilesPerMessage) {
      selected.push(fileId);
      selectedSet.add(fileId);
      attached.push(file);
    } else {
      overflow.push(file);
    }
  }

  return { selectedFileIds: selected, pendingFileIds: pending, attached, failed, overflow };
}
