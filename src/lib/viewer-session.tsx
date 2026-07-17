"use client";

import { createContext, useContext, type ReactNode } from "react";

const ViewerSessionContext = createContext<string | null>(null);

export function ViewerSessionProvider({ token, children }: { token: string; children: ReactNode }) {
  return <ViewerSessionContext.Provider value={token}>{children}</ViewerSessionContext.Provider>;
}

export function useViewerSession(): string | null {
  return useContext(ViewerSessionContext);
}
