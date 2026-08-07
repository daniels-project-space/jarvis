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
import { resolveConvexUrl } from "@/lib/convex-url";
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

function useJarvisConvexAuth() {
  const auth = useContext(ViewerAuthContext);
  return useMemo(() => ({
    isLoading: auth === null,
    isAuthenticated: auth !== null,
    fetchAccessToken: auth?.fetchAccessToken ?? (async () => null),
  }), [auth]);
}

export default function Providers({ children }: { children: ReactNode }) {
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const viewerTokenRef = useRef<string | null>(null);
  const refreshPromiseRef = useRef<Promise<string> | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const retryViewerToken = useCallback(() => {
    setError(false);
    setRetryNonce((value) => value + 1);
  }, []);

  const acceptViewerToken = useCallback((token: string) => {
    viewerTokenRef.current = token;
    setViewerRequestToken(token);
    setViewerToken((current) => (current === token ? current : token));
  }, []);

  const refreshViewerToken = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const request = requestViewerToken()
      .then((token) => {
        acceptViewerToken(token);
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
    void requestViewerToken()
      .then((token) => {
        if (active) acceptViewerToken(token);
      })
      .catch(() => {
        if (!active) return;
        setError(true);
        retryTimer = setTimeout(retryViewerToken, 2_000);
      });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [acceptViewerToken, retryNonce, retryViewerToken]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
        <section className="w-full max-w-lg overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(245,166,35,0.13),transparent_45%),rgba(14,14,16,0.96)] p-7 shadow-[0_30px_100px_rgba(0,0,0,0.6)] sm:p-9">
          <div className="mb-5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber shadow-[0_0_18px_rgba(245,166,35,0.8)]" />
            Reconnecting
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">Jarvis is coming back online.</h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            This workspace opens automatically. Jarvis will keep retrying in the background.
          </p>
          <button
            type="button"
            onClick={retryViewerToken}
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 transition hover:text-white/75"
          >
            Retry now
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
