// A zero-network courtesy lane for small social openings. It makes JARVIS feel
// present while the subscription-backed CLI lane handles anything that needs
// thought, tools, memory, or a real answer.

const normalise = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9'?\s]/g, "").replace(/\s+/g, " ");

export function instantSocialReply(input: string): string | null {
  const text = normalise(input);
  if (/^(?:(?:hi|hello|hey)(?: jarvis)?|jarvis|morning|good morning|afternoon|good afternoon|evening|good evening)$/.test(text)) {
    return "Right here, sir. What's the first thing we're sorting?";
  }
  if (/^(you there|are you there|still there|hello\?)$/.test(text)) {
    return "Always. What needs me?";
  }
  if (/^(how are you|how're you|hows it going|how's it going|whats up|what's up|sup)$/.test(text)) {
    return "Sharp, present, and mildly suspicious you're about to make my day interesting. You?";
  }
  return null;
}
