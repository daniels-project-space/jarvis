export type EmbeddedThreadContext = {
  actorKey: string;
  threadId: string | null;
  hydrated: boolean;
};

type ViewerClaims = {
  project?: unknown;
  role?: unknown;
  sub?: unknown;
};

function readableViewerIdentity(token: string | null): string {
  if (!token) return "viewer-pending";
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return "unrecognized-viewer";
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as ViewerClaims;
    if (claims.project !== "jarvis" || typeof claims.sub !== "string") return "unrecognized-viewer";
    if (claims.role === "owner" && claims.sub === "daniel-owner") return `owner:${claims.sub}`;
    if (claims.role === "guest" && claims.sub.startsWith("jarvis-guest:")) return `guest:${claims.sub}`;
    return "unrecognized-viewer";
  } catch {
    return "unrecognized-viewer";
  }
}

/** The provider has already verified this capability. Reading only its stable
 * role/subject keeps routine token rotation from looking like an actor swap. */
export function stableEmbeddedActorKey(parentOrigin: string | null, viewerToken: string | null): string {
  return `${parentOrigin ?? "origin-pending"}|${readableViewerIdentity(viewerToken)}`;
}

export function reconcileEmbeddedThreadReadiness(
  previous: EmbeddedThreadContext | null,
  next: EmbeddedThreadContext,
  wasReady: boolean,
): { ready: boolean; discardPending: boolean } {
  const actorChanged = previous !== null && previous.actorKey !== next.actorKey;
  const threadChanged = previous !== null && previous.threadId !== next.threadId;
  return {
    ready: wasReady && next.hydrated && !actorChanged && !threadChanged,
    discardPending: actorChanged,
  };
}
