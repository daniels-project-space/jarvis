/**
 * Client-safe state rules for an iCloud Calendar approval card.
 *
 * The sealed receipt nonce is the CalDAV write idempotency key. A lost or
 * transient provider response can therefore be retried with the same card
 * without creating a second event while the receipt remains valid.
 */
export type ICloudCalendarApprovalCardState = "ready" | "approving" | "completed" | "error" | "expired";

/**
 * A sealed approval receipt is deliberately short-lived. Only a provider
 * failure can safely be retried with the same nonce; a 400 means the receipt
 * itself was rejected or expired, so a new owner-approved proposal is needed.
 */
export function iCloudCalendarApprovalFailureState(status: number): ICloudCalendarApprovalCardState {
  // A 409 means a revision-bound travel receipt is stale. Retrying that same
  // button cannot become safe again; request a fresh protected approval.
  return status === 400 || status === 409 ? "expired" : "error";
}

export function canSubmitICloudCalendarApproval(state: ICloudCalendarApprovalCardState): boolean {
  return state === "ready" || state === "error";
}

export function iCloudCalendarApprovalButtonLabel(state: ICloudCalendarApprovalCardState): string {
  if (state === "approving") return "saving…";
  if (state === "error") return "Retry iCloud event";
  if (state === "expired") return "Approval expired";
  return "Approve iCloud event";
}
