/** Remove volatile provider/request identifiers before incident deduplication. */
export function normalizeIncidentSignature(value: unknown, maxChars = 200): string {
  return String(value ?? "")
    .replace(/\[\s*request[ _-]?id\s*:\s*[^\]]+\]/gi, "[request-id]")
    .replace(/\brequest[ _-]?id\s*[=:]\s*[a-z0-9_-]+/gi, "request-id")
    .replace(/https?:\/\/[^/\s]+\/_next\/static\/chunks\/[^\s)]+/gi, "<next-chunk>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, maxChars));
}
