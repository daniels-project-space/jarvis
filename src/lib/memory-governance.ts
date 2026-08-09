const SAFE_KIND = /^[a-z][a-z0-9_-]{0,39}$/;

function terms(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length > 1)
    .slice(0, 14) ?? [];
}

/** A deterministic identity for a stable memory claim, never for raw chat. */
export function memoryDedupeKey(kind: string, title: string): string | null {
  const safeKind = String(kind).trim().toLocaleLowerCase("en-US");
  if (!SAFE_KIND.test(safeKind)) return null;
  const keyTerms = terms(String(title));
  if (keyTerms.length === 0) return null;
  return `v1:${safeKind}:${keyTerms.join("-")}`.slice(0, 180);
}

export function memoryConfidence(value: unknown, fallback = 0.7): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(0, Math.min(1, number)) * 100) / 100;
}
