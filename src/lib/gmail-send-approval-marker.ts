/**
 * Client-safe marker framing a signed Gmail-draft send approval in assistant
 * text. The opaque token is parsed and redeemed only by trusted server code.
 */
export const GMAIL_SEND_APPROVAL_MARKER = "jarvis-gmail-send-approval";
