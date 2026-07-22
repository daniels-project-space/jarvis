"use client";

import { createContext, useContext, type ReactNode } from "react";

const ViewerSessionContext = createContext<string | null>(null);

export function ViewerSessionProvider({ token, children }: { token: string; children: ReactNode }) {
  return <ViewerSessionContext.Provider value={token}>{children}</ViewerSessionContext.Provider>;
}

export function useViewerSession(): string | null {
  return useContext(ViewerSessionContext);
}

/** JWT claims are signed, but intentionally readable in the browser. This is
 * only a rendering guard; every server and Convex boundary authorizes again. */
export function isGuestViewerSession(token: string | null): boolean {
  if (!token) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return json?.role === "guest" && typeof json?.sub === "string" && json.sub.startsWith("jarvis-guest:");
  } catch {
    return false;
  }
}
