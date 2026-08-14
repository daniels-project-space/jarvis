/**
 * Safe, client-shareable facts about the controller-managed Codex session.
 *
 * The actual ChatGPT subscription state, refresh token, and operator signal
 * stay server-only. This module exposes only the finite error code already
 * intentionally present in the durable work-control record.
 */
export const CODEX_SESSION_UNAVAILABLE_CODES = [
  "configuration_missing",
  "source_rejected",
  "credential_broker_unavailable",
  "session_store_unavailable",
  "snapshot_corrupt",
  "snapshot_stale",
  "writer_timeout",
  "writer_fence_lost",
  "rotation_uncertain",
  "rotation_failed",
  "refresh_token_reused",
] as const;

export type CodexSessionUnavailableCode = typeof CODEX_SESSION_UNAVAILABLE_CODES[number];

const UNAVAILABLE_CODE_SET = new Set<string>(CODEX_SESSION_UNAVAILABLE_CODES);
const UNAVAILABLE_SIGNAL = /JARVIS_CODEX_SESSION_UNAVAILABLE\[([a-z_]+)\]:/;

export function isCodexSessionUnavailableCode(value: unknown): value is CodexSessionUnavailableCode {
  return typeof value === "string" && UNAVAILABLE_CODE_SET.has(value);
}

/**
 * Extracts the public, bounded error category from the controller's deliberate
 * operator signal. It never returns the signal body, which may be persisted in
 * a worker checkpoint but must not become a client-side transport contract.
 */
export function codexSessionUnavailableCode(value: unknown): CodexSessionUnavailableCode | null {
  if (typeof value !== "string") return null;
  const candidate = value.match(UNAVAILABLE_SIGNAL)?.[1];
  return candidate && isCodexSessionUnavailableCode(candidate)
    ? candidate as CodexSessionUnavailableCode
    : null;
}

export type ControllerSessionStatus = "checking" | "clear" | "repair_required" | "unavailable";
export type ControllerSessionReadiness =
  | { state: "clear" }
  | { state: "repair_required"; code: CodexSessionUnavailableCode };

export function controllerSessionStatusPresentation(
  status: ControllerSessionStatus,
  code?: CodexSessionUnavailableCode | null,
): { label: string; hint: string; tone: "ready" | "attention" | "neutral" } {
  if (status === "clear") {
    return {
      label: "no repair hold",
      hint: "No unresolved background task has reported a controller-session failure.",
      tone: "ready",
    };
  }
  if (status === "repair_required") {
    return {
      label: "repair needed",
      hint: `Background agents are paused safely for controller-session repair${code ? ` (${code})` : ""}. Re-enrol the managed ChatGPT session, then resume the held work.`,
      tone: "attention",
    };
  }
  if (status === "unavailable") {
    return {
      label: "status unavailable",
      hint: "Jarvis could not read the durable controller-session status. New work remains available, but its session safety is not confirmed here.",
      tone: "neutral",
    };
  }
  return {
    label: "checking…",
    hint: "Reading the durable controller-session status.",
    tone: "neutral",
  };
}
