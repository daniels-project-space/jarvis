export class NarrationLedger {
  private readonly claims = new Map<string, number>();

  claim(key: string, now = Date.now()): boolean {
    for (const [existing, claimedAt] of this.claims) {
      if (now - claimedAt > 10 * 60_000) this.claims.delete(existing);
    }
    if (this.claims.has(key)) return false;
    this.claims.set(key, now);
    return true;
  }
}

function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A stable ownership key for one exact spoken range of one logical turn. */
export function narrationClaim(scope: string, text: string, from = 0, to = text.length): string {
  return `${scope}:${from}-${to}:${textHash(text.slice(from, to))}`;
}

