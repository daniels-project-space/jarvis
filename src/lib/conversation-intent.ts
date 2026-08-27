// Keep the conversational fast path intentionally narrow. A greeting prefix
// must not make a real request look like a greeting just because it begins
// with "hey Jarvis".
const CONVERSATIONAL_REFLEX = /^(?:(?:hi|hey|hello|yo|sup)(?:[\s,]+jarvis)?|(?:thanks|thank you)(?:[\s,]+jarvis)?|ok(?:ay)?(?:[\s,]+jarvis)?|(?:morning|evening)(?:[\s,]+jarvis)?|good (?:morning|evening|day)(?:[\s,]+jarvis)?|what'?s up(?:[\s,]+jarvis)?|how are you(?:[\s,]+jarvis)?)[!.?\s]*$/i;

export function isConversationalReflex(value: string | undefined): boolean {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return !normalized || CONVERSATIONAL_REFLEX.test(normalized);
}
