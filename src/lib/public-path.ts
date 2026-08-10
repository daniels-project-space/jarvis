/** Paths that must stay reachable before an owner/viewer session exists. */
export function isJarvisPublicPath(pathname: string): boolean {
  return !pathname.startsWith("/api/")
    || pathname === "/api/auth/viewer"
    || pathname === "/api/auth/pair"
    || pathname === "/api/agent-tool"
    || pathname === "/api/health"
    // The outbound VPS runner has its own mandatory, timing-safe bearer
    // capability in the route handler. It cannot carry a browser session.
    || pathname === "/api/local-handover/runner";
}
