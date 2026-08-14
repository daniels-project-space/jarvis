export type CreationMediaVariant = "asset" | "thumb";

// This helper intentionally has no server-only imports: the authenticated
// browser UI can safely render the first-party route without ever receiving an
// R2 key or a signed storage URL.
export function creationMediaUrl(creationId: string, variant: CreationMediaVariant = "asset"): string {
  const id = String(creationId).trim();
  if (!id || id.length > 160) throw new Error("invalid creation media identity");
  if (variant !== "asset" && variant !== "thumb") throw new Error("invalid creation media variant");
  const query = new URLSearchParams({ id, variant });
  return `/api/creation-media?${query.toString()}`;
}
