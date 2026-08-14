export type VoiceTurnAdmission = "foreground" | "fast-dispatch" | "background-dispatch" | "blocked";

/**
 * Only a deterministic specialist handoff may overlap an active foreground
 * model turn. Every other request remains serialized so one conversation
 * cannot produce competing model/tool work behind the user's back.
 */
export function resolveVoiceTurnAdmission(input: {
  foregroundBusy: boolean;
  hasFastDispatch: boolean;
}): VoiceTurnAdmission {
  if (input.hasFastDispatch) {
    return input.foregroundBusy ? "background-dispatch" : "fast-dispatch";
  }
  return input.foregroundBusy ? "blocked" : "foreground";
}
