"use client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { resolveConvexUrl } from "@/lib/convex-url";
import { resolveTrustedJarvisEmbedOrigin } from "@/lib/embed-origin";
import { ViewerSessionProvider } from "@/lib/viewer-session";
import { setViewerRequestToken } from "@/lib/viewer-request";
import { ConvexAuthGate } from "./ConvexAuthGate";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL), {
  // The viewer JWT is already fresh when this provider mounts. Reusing it lets
  // Convex schedule one refresh from its expiry instead of immediately
  // authenticating twice and rerunning every protected subscription.
  initialAuthTokenReuse: true,
});

type ViewerAuth = {
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
};
const ViewerAuthContext = createContext<ViewerAuth | null>(null);

class ViewerTokenError extends Error {
  constructor(readonly status?: number) {
    super(status ? `viewer capability rejected (${status})` : "viewer capability unavailable");
  }
}

type AuthFailure = "locked" | "offline";
type StoredEmbedGrant = { hostOrigin: string; controlToken: string; expiresAt: number };
const EMBED_GRANT_KEY = "jarvis_owner_embed_grant_v1";

function currentEmbedHostOrigin(): string | null {
  if (typeof window === "undefined" || (window.location.pathname !== "/embed" && window.self === window.top)) return null;
  return resolveTrustedJarvisEmbedOrigin({
    declaredOrigin: new URLSearchParams(window.location.search).get("hostOrigin"),
    referrer: document.referrer,
    ancestorOrigin: window.location.ancestorOrigins?.[0] ?? null,
  });
}

function storedEmbedGrant(hostOrigin: string): StoredEmbedGrant | null {
  let serialized: string | null = null;
  try { serialized = localStorage.getItem(EMBED_GRANT_KEY); } catch { /* use the tab fallback */ }
  if (!serialized) {
    try { serialized = sessionStorage.getItem(EMBED_GRANT_KEY); } catch { return null; }
  }
  try {
    const value = JSON.parse(serialized ?? "null") as StoredEmbedGrant | null;
    const valid = value
      && value.hostOrigin === hostOrigin
      && /^[A-Za-z0-9_-]{40,128}$/.test(value.controlToken)
      && value.expiresAt > Date.now();
    if (!valid) {
      clearStoredEmbedGrant();
      return null;
    }
    // Migrate the original tab-scoped grant so the trusted Project Hub overlay
    // stays connected after a browser restart instead of showing a false lock.
    persistEmbedGrant(value);
    return value;
  } catch {
    return null;
  }
}

function clearStoredEmbedGrant() {
  try { localStorage.removeItem(EMBED_GRANT_KEY); } catch { /* storage can be partition-blocked */ }
  try { sessionStorage.removeItem(EMBED_GRANT_KEY); } catch { /* keep the owner flow recoverable */ }
}

function persistEmbedGrant(grant: StoredEmbedGrant) {
  const serialized = JSON.stringify(grant);
  try {
    localStorage.setItem(EMBED_GRANT_KEY, serialized);
    try { sessionStorage.removeItem(EMBED_GRANT_KEY); } catch { /* persistent copy is enough */ }
    return;
  } catch {
    // Some embedded browsers deny persistent storage. Preserve the existing
    // tab-scoped fallback rather than breaking a successful owner connection.
    try { sessionStorage.setItem(EMBED_GRANT_KEY, serialized); } catch { /* current in-memory token still works */ }
  }
}

async function requestEmbedViewer(controlToken: string, hostOrigin: string): Promise<string> {
  const response = await fetch("/api/auth/embed-viewer", {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${controlToken}`,
      "x-jarvis-embed-origin": hostOrigin,
    },
  });
  if (!response.ok) throw new ViewerTokenError(response.status);
  const payload = await response.json();
  if (typeof payload.viewerToken !== "string") throw new Error("viewer capability missing");
  return payload.viewerToken;
}

async function requestViewerToken(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const embedded = window.location.pathname === "/embed" || window.self !== window.top;
      const response = await fetch("/api/auth/viewer", {
        method: "POST",
        cache: "no-store",
        headers: embedded ? { "x-jarvis-embed": "1" } : undefined,
      });
      if (!response.ok) throw new ViewerTokenError(response.status);
      const payload = await response.json();
      if (typeof payload.viewerToken !== "string") throw new Error("viewer capability missing");
      return payload.viewerToken;
    } catch (error) {
      lastError = error;
      if (error instanceof ViewerTokenError && (error.status === 401 || error.status === 403)) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("viewer capability unavailable");
}

async function requestOwnerViewer(hostOrigin: string | null): Promise<{
  token: string;
  grant: StoredEmbedGrant | null;
}> {
  const grant = hostOrigin ? storedEmbedGrant(hostOrigin) : null;
  if (grant && hostOrigin) {
    try {
      return { token: await requestEmbedViewer(grant.controlToken, hostOrigin), grant };
    } catch (error) {
      // A 401/403 definitively revokes this capability. Network and 5xx errors
      // keep it intact so the next retry reconnects without another popup.
      const revoked = error instanceof ViewerTokenError && (error.status === 401 || error.status === 403);
      if (!revoked) throw error;
      clearStoredEmbedGrant();
    }
  }
  return { token: await requestViewerToken(), grant: null };
}

function useJarvisConvexAuth() {
  const auth = useContext(ViewerAuthContext);
  return useMemo(() => ({
    isLoading: auth === null,
    isAuthenticated: auth !== null,
    fetchAccessToken: auth?.fetchAccessToken ?? (async () => null),
  }), [auth]);
}

export default function Providers({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Pairing must render before viewer authentication exists. Wrapping /pair in
  // the owner gate made every fresh owner link impossible to consume: Daniel
  // saw the lock screen instead of the page that creates his durable cookie.
  if (pathname === "/pair") return <>{children}</>;
  return <OwnerProviders>{children}</OwnerProviders>;
}

function OwnerProviders({ children }: { children: ReactNode }) {
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const viewerTokenRef = useRef<string | null>(null);
  const refreshPromiseRef = useRef<Promise<string> | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retryViewerToken = useCallback(() => {
    setError(null);
    setRetryNonce((value) => value + 1);
  }, []);

  const acceptViewerToken = useCallback((token: string, apiToken?: string, embedOrigin?: string) => {
    viewerTokenRef.current = token;
    setViewerRequestToken(apiToken ?? null, embedOrigin ?? null);
    setViewerToken((current) => (current === token ? current : token));
  }, []);

  const refreshViewerToken = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const hostOrigin = currentEmbedHostOrigin();
    const request = requestOwnerViewer(hostOrigin)
      .then(({ token, grant }) => {
        acceptViewerToken(token, grant?.controlToken, grant?.hostOrigin);
        return token;
      })
      .finally(() => {
        refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = request;
    return request;
  }, [acceptViewerToken]);

  // This callback must keep the same identity when a refreshed JWT is stored.
  // Convex treats a changed token-fetch callback as a completely new auth
  // configuration: it pauses the websocket and reruns every live query. The
  // previous callback closed over React token state, creating a refresh/render/
  // re-auth loop that hid captions and consumed database reads continuously.
  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    const current = viewerTokenRef.current;
    if (!forceRefreshToken && current) return current;
    try {
      return await refreshViewerToken();
    } catch {
      // A short network transition should not discard a still-valid six-hour
      // capability. Convex can retry after the socket recovers.
      return current;
    }
  }, [refreshViewerToken]);

  const auth = useMemo<ViewerAuth>(() => ({ fetchAccessToken }), [fetchAccessToken]);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const hostOrigin = currentEmbedHostOrigin();
    const load = async () => {
      const { token, grant } = await requestOwnerViewer(hostOrigin);
      if (active) acceptViewerToken(token, grant?.controlToken, grant?.hostOrigin);
    };
    void load().catch((cause) => {
        if (!active) return;
        const locked = cause instanceof ViewerTokenError && (cause.status === 401 || cause.status === 403);
        setError(locked ? "locked" : "offline");
        if (!locked) retryTimer = setTimeout(retryViewerToken, 2_000);
      });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [acceptViewerToken, retryNonce, retryViewerToken]);

  const connectEmbeddedOwner = useCallback(() => {
    const hostOrigin = currentEmbedHostOrigin();
    if (!hostOrigin) {
      retryViewerToken();
      return;
    }
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const url = new URL("/api/auth/embed-connect", window.location.origin);
    url.searchParams.set("hostOrigin", hostOrigin);
    url.searchParams.set("state", state);
    const popup = window.open(url, "jarvis-owner-connect", "popup,width=520,height=540");
    if (!popup) {
      setError("locked");
      return;
    }
    const timeout = window.setTimeout(() => window.removeEventListener("message", receive), 90_000);
    function receive(event: MessageEvent) {
      const payload = event.data as Partial<StoredEmbedGrant> & { jarvis?: string; state?: string; viewerToken?: string };
      if (
        event.source !== popup
        || event.origin !== window.location.origin
        || payload.jarvis !== "owner-embed-grant"
        || payload.state !== state
        || payload.hostOrigin !== hostOrigin
        || typeof payload.viewerToken !== "string"
        || typeof payload.controlToken !== "string"
        || typeof payload.expiresAt !== "number"
      ) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      const grant = { hostOrigin, controlToken: payload.controlToken, expiresAt: payload.expiresAt };
      persistEmbedGrant(grant);
      setError(null);
      acceptViewerToken(payload.viewerToken, payload.controlToken, hostOrigin);
    }
    window.addEventListener("message", receive);
  }, [acceptViewerToken, retryViewerToken]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
        <section className="w-full max-w-lg overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(245,166,35,0.13),transparent_45%),rgba(14,14,16,0.96)] p-7 shadow-[0_30px_100px_rgba(0,0,0,0.6)] sm:p-9">
          <div className="mb-5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber shadow-[0_0_18px_rgba(245,166,35,0.8)]" />
            {error === "locked" ? "Private owner workspace" : "Reconnecting"}
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
            {error === "locked" ? "Jarvis is locked to Daniel." : "Jarvis is coming back online."}
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            {error === "locked"
              ? (currentEmbedHostOrigin()
                ? "Connect this trusted overlay to your paired Jarvis browser. No guest conversation will be created."
                : "Open your short-lived, single-use owner pairing link in this browser, then retry.")
              : "Jarvis will keep retrying in the background."}
          </p>
          <button
            type="button"
            onClick={error === "locked" && currentEmbedHostOrigin() ? connectEmbeddedOwner : retryViewerToken}
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 transition hover:text-white/75"
          >
            {error === "locked" && currentEmbedHostOrigin() ? "Connect owner workspace" : "Retry now"}
          </button>
        </section>
      </main>
    );
  }
  if (!viewerToken) return <main aria-label="Initializing Jarvis" className="min-h-screen bg-black" />;
  return (
    <ViewerAuthContext.Provider value={auth}>
      <ViewerSessionProvider token={viewerToken}>
        <ConvexProviderWithAuth client={convex} useAuth={useJarvisConvexAuth}>
          <ConvexAuthGate>{children}</ConvexAuthGate>
        </ConvexProviderWithAuth>
      </ViewerSessionProvider>
    </ViewerAuthContext.Provider>
  );
}
