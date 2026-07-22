/**
 * Persistent cards can represent privileged visual output. Guest foreground
 * chat deliberately remains text/voice-only, including for historical rows
 * written before that boundary existed.
 */
export function canRenderPersistentAttachment<T>(isGuest: boolean, attachment: T | null | undefined): attachment is T {
  return !isGuest && attachment !== undefined && attachment !== null;
}
