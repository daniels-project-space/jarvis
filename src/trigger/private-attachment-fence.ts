import { FILE_READY_STATUSES, type ChatFileManifest } from "../lib/chat-files";

/**
 * A queue claim is deliberately a snapshot, so it can be retried deterministically.
 * Private object keys are different: they must be refreshed at the worker boundary
 * because the owner can delete a source between claim and materialization.
 */
export type PrivateClaimAttachment = ChatFileManifest & {
  r2Key: string;
  previewR2Key?: string;
};

function readyAttachment(value: unknown): PrivateClaimAttachment | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Partial<PrivateClaimAttachment>;
  if (
    typeof file.fileId !== "string"
    || typeof file.name !== "string"
    || typeof file.relativePath !== "string"
    || typeof file.mimeType !== "string"
    || typeof file.sizeBytes !== "number"
    || typeof file.status !== "string"
    || typeof file.r2Key !== "string"
    || !file.r2Key
    || !FILE_READY_STATUSES.has(file.status)
  ) return null;
  return file as PrivateClaimAttachment;
}

/** Keep the claim's exact attachment set and ordering, but replace its private
 * object metadata with a current ready-file manifest. Any unreadable response,
 * missing file, or deleting/deleted status fails closed by omitting that file. */
export function reconcileReadyClaimAttachments(
  claimed: readonly PrivateClaimAttachment[],
  live: unknown,
): PrivateClaimAttachment[] {
  const liveByFileId = new Map<string, PrivateClaimAttachment>();
  if (Array.isArray(live)) {
    for (const value of live) {
      const file = readyAttachment(value);
      if (file) liveByFileId.set(file.fileId, file);
    }
  }
  return claimed.flatMap((claimedFile) => {
    const current = liveByFileId.get(claimedFile.fileId);
    if (!current) return [];
    return [{
      ...current,
      selection: claimedFile.selection ?? current.selection,
    }];
  });
}

/** A Convex read failure must never turn an old manifest into model input. */
export async function resolveReadyClaimAttachments(
  claimed: readonly PrivateClaimAttachment[],
  readLive: () => Promise<unknown>,
): Promise<PrivateClaimAttachment[]> {
  if (!claimed.length) return [];
  try {
    return reconcileReadyClaimAttachments(claimed, await readLive());
  } catch {
    return [];
  }
}

/** Image materialization is safe to reuse only when every private object source
 * is exactly the current one that will be sent to the model. */
export function samePrivateAttachmentSources(
  left: readonly PrivateClaimAttachment[],
  right: readonly PrivateClaimAttachment[],
): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return Boolean(other)
      && file.fileId === other.fileId
      && file.r2Key === other.r2Key
      && file.previewR2Key === other.previewR2Key
      && file.mimeType === other.mimeType
      && file.sizeBytes === other.sizeBytes
      && file.status === other.status;
  });
}
