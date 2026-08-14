"use client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { resolveConvexUrl } from "@/lib/convex-url";
import { ViewerSessionProvider } from "@/lib/viewer-session";
import { setViewerRequestToken } from "@/lib/viewer-request";
import { ConvexAuthGate } from "./ConvexAuthGate";
import { JarvisBootShell } from "./JarvisBootShell";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL), {
  // The viewer JWT is already fresh when this provider mounts. Reusing it lets
  // Convex schedule one refresh from its expiry instead of immediately
  // authenticating twice and rerunning every protected subscription.
  initialAuthTokenReuse: true,
});

type ViewerAuth = {
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
};
type ViewerCapability = {
  token: string;
  expiresAt: number | null;
};
const ViewerAuthContext = createContext<ViewerAuth | null>(null);

class ViewerTokenError extends Error {
  constructor(readonly status?: number) {
    super(status ? `viewer capability rejected (${status})` : "viewer capability unavailable");
  }
}

type AuthFailure = "offline";

async function requestViewerToken(): Promise<ViewerCapability> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("/api/auth/viewer", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new ViewerTokenError(response.status);
      const payload = await response.json();
      if (typeof payload.viewerToken !== "string") throw new Error("viewer capability missing");
      return {
        token: payload.viewerToken,
        expiresAt: typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt)
          ? payload.expiresAt
          : null,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof ViewerTokenError && (error.status === 401 || error.status === 403)) break;
      if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("viewer capability unavailable");
}

export function viewerRetryDelayMs(failureCount: number, random = Math.random()): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(0, failureCount), 5));
  const jitter = 0.85 + Math.min(1, Math.max(0, random)) * 0.3;
  return Math.min(60_000, Math.round(base * jitter));
}

function useJarvisConvexAuth() {
  const auth = useContext(ViewerAuthContext);
  return useMemo(() => ({
    isLoading: auth === null,
    isAuthenticated: auth !== null,
    fetchAccessToken: auth?.fetchAccessToken ?? (async () => null),
  }), [auth]);
}

export default function Providers({
  children,
  /** A short-lived signed capability issued after server-side session validation. */
  initialViewerToken,
  initialViewerTokenExpiresAt,
}: {
  children: ReactNode;
  initialViewerToken?: string | null;
  initialViewerTokenExpiresAt?: number | null;
}) {
  return (
    <OwnerProviders
      initialViewerToken={initialViewerToken}
      initialViewerTokenExpiresAt={initialViewerTokenExpiresAt}
    >
      {children}
    </OwnerProviders>
  );
}

function OwnerProviders({
  children,
  initialViewerToken,
  initialViewerTokenExpiresAt,
}: {
  children: ReactNode;
  initialViewerToken?: string | null;
  initialViewerTokenExpiresAt?: number | null;
}) {
  // The app shell used to render black until this client component finished a
  // POST to /api/auth/viewer. A server-issued JWT is already the same bounded
  // capability Convex expects, so use it synchronously. A missing bootstrap
  // value keeps the established client recovery path intact.
  const bootstrapTokenRef = useRef<string | null>(
    typeof initialViewerToken === "string" && initialViewerToken.trim() ? initialViewerToken : null,
  );
  const [viewerToken, setViewerToken] = useState<string | null>(bootstrapTokenRef.current);
  const viewerTokenRef = useRef<string | null>(bootstrapTokenRef.current);
  const viewerTokenExpiresAtRef = useRef<number | null>(
    bootstrapTokenRef.current && typeof initialViewerTokenExpiresAt === "number"
      ? initialViewerTokenExpiresAt
      : null,
  );
  // `viewerFetch` is module-scoped so its Authorization header must be ready
  // during hydration, before descendant passive effects can issue a same-origin
  // API call. A layout effect runs before paint without mutating browser state
  // from an abandoned React render.
  useLayoutEffect(() => {
    if (bootstrapTokenRef.current) setViewerRequestToken(bootstrapTokenRef.current);
  }, []);
  const refreshPromiseRef = useRef<Promise<ViewerCapability> | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retryViewerToken = useCallback(() => {
    setError(null);
    setRetryNonce((value) => value + 1);
  }, []);

  const acceptViewerToken = useCallback(({ token, expiresAt }: ViewerCapability) => {
    viewerTokenRef.current = token;
    viewerTokenExpiresAtRef.current = expiresAt;
    // The short-lived signed owner viewer capability is also verified at the
    // server API boundary. This keeps third-party-cookie-blocked overlays fully
    // functional without popup pairing or a second Convex control session.
    setViewerRequestToken(token);
    setViewerToken((current) => (current === token ? current : token));
  }, []);

  const refreshViewerToken = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const request = requestViewerToken()
      .then((capability) => {
        acceptViewerToken(capability);
        return capability;
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
      return (await refreshViewerToken()).token;
    } catch {
      // A short network transition should not discard a still-valid six-hour
      // capability. Convex can retry after the socket recovers.
      return current;
    }
  }, [refreshViewerToken]);

  const auth = useMemo<ViewerAuth>(() => ({ fetchAccessToken }), [fetchAccessToken]);

  useEffect(() => {
    let active = true;
    let retryQueued = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const tokenNeedsRefresh = () => {
      const expiresAt = viewerTokenExpiresAtRef.current;
      return !viewerTokenRef.current || !expiresAt || expiresAt <= Date.now() + 2 * 60_000;
    };
    const retryWhenAvailable = () => {
      if (retryQueued || document.hidden || !navigator.onLine) return;
      if (!tokenNeedsRefresh()) return;
      retryQueued = true;
      retryViewerToken();
    };
    const load = async () => {
      if (!tokenNeedsRefresh()) return;
      await refreshViewerToken();
    };
    void load().catch(() => {
        if (!active) return;
        // A server-bootstrap token remains usable during a brief offline
        // transition. Keep Jarvis visible and let the retry loop refresh it
        // rather than replacing the running UI with a full-screen error.
        if (!viewerTokenRef.current) setError("offline");
        if (!document.hidden && navigator.onLine) {
          retryTimer = setTimeout(retryWhenAvailable, viewerRetryDelayMs(retryNonce));
        }
      });
    window.addEventListener("online", retryWhenAvailable);
    document.addEventListener("visibilitychange", retryWhenAvailable);
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener("online", retryWhenAvailable);
      document.removeEventListener("visibilitychange", retryWhenAvailable);
    };
  }, [acceptViewerToken, refreshViewerToken, retryNonce, retryViewerToken]);

  if (error && !viewerToken) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
        <section className="w-full max-w-lg overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(245,166,35,0.13),transparent_45%),rgba(14,14,16,0.96)] p-7 shadow-[0_30px_100px_rgba(0,0,0,0.6)] sm:p-9">
          <div className="mb-5 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber shadow-[0_0_18px_rgba(245,166,35,0.8)]" />
            Reconnecting
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
            Jarvis is coming back online.
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            Jarvis will keep retrying in the background.
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
  if (!viewerToken) return <JarvisBootShell />;
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
