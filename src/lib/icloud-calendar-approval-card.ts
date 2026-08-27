/**
 * Client-safe state rules for an iCloud Calendar approval card.
 *
 * The sealed receipt nonce is the CalDAV write idempotency key. A lost or
 * transient provider response can therefore be retried with the same card
 * without creating a second event while the receipt remains valid.
 */
export type ICloudCalendarApprovalCardState = "ready" | "approving" | "completed" | "error";

export function canSubmitICloudCalendarApproval(state: ICloudCalendarApprovalCardState): boolean {
  return state === "ready" || state === "error";
}

export function iCloudCalendarApprovalButtonLabel(state: ICloudCalendarApprovalCardState): string {
  if (state === "approving") return "saving…";
  if (state === "error") return "Retry iCloud event";
  return "Approve iCloud event";
}
