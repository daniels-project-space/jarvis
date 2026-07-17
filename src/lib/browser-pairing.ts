const PAIRING_TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

/** Accept either the one-use URL Jarvis creates or its capability token. */
export function extractPairingToken(value: string): string | null {
  const input = value.trim();
  if (PAIRING_TOKEN.test(input)) return input;
  if (!input) return null;

  try {
    const parsed = new URL(input, "https://jarvis.invalid");
    const token = new URLSearchParams(parsed.hash.slice(1)).get("pair")
      ?? parsed.searchParams.get("pair");
    return token && PAIRING_TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}
