/** Paths that must stay reachable before an owner/viewer session exists. */
export function isJarvisPublicPath(pathname: string): boolean {
  return !pathname.startsWith("/api/")
    || pathname === "/api/auth/viewer"
    || pathname === "/api/auth/pair"
    || pathname === "/api/agent-tool"
    // This transport authenticates the worker capability in its route. The
    // browser-session middleware must not consume a worker bearer first.
    || pathname === "/api/activity-recovery"
    || pathname === "/api/health";
}
