export type FinalDeliveryCursor = {
  threadId: string;
  initialized: boolean;
  lastMessageId: string | null;
};

export type FinalDeliveryCandidate = {
  id: string;
  parentMessageId?: string;
};

export function advanceFinalDelivery(
  cursor: FinalDeliveryCursor,
  input: {
    threadId: string;
    hydrated: boolean;
    latest: FinalDeliveryCandidate | null;
    activeParentMessageId?: string;
  },
): { cursor: FinalDeliveryCursor; deliver: boolean } {
  let next = cursor.threadId === input.threadId
    ? cursor
    : { threadId: input.threadId, initialized: false, lastMessageId: null };
  if (!input.hydrated) return { cursor: next, deliver: false };

  if (!next.initialized) {
    next = { ...next, initialized: true };
    const belongsToActiveTurn = Boolean(
      input.latest && input.latest.parentMessageId === input.activeParentMessageId,
    );
    if (!belongsToActiveTurn) {
      return {
        cursor: { ...next, lastMessageId: input.latest?.id ?? null },
        deliver: false,
      };
    }
  }

  if (!input.latest || input.latest.id === next.lastMessageId) return { cursor: next, deliver: false };
  return { cursor: { ...next, lastMessageId: input.latest.id }, deliver: true };
}
