"use client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { resolveConvexUrl } from "@/lib/convex-url";
import { ViewerSessionProvider } from "@/lib/viewer-session";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL));

type ViewerAuth = { token: string; refresh: () => Promise<string> };
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
      const response = await fetch("/api/auth/viewer", { method: "POST", cache: "no-store" });
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
    fetchAccessToken: async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (!auth) return null;
      if (!forceRefreshToken) return auth.token;
      // Convex requests a refresh when its websocket reconnects. A browser
      // network transition can briefly abort that HTTP request even though the
      // current six-hour viewer JWT remains valid. Keep the live connection on
      // the existing capability and let the next transition retry, rather than
      // leaking an unhandled rejection into the self-repair pipeline.
      try {
        return await auth.refresh();
      } catch {
        return auth.token;
      }
    },
  }), [auth]);
}

export default function Providers({ children }: { children: ReactNode }) {
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const refreshViewerToken = useCallback(async () => {
    const token = await requestViewerToken();
    setViewerToken(token);
    return token;
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setError(false);
    void requestViewerToken()
      .then((token) => {
        if (active) setViewerToken(token);
      })
      .catch(() => {
        if (!active) return;
        setError(true);
        retryTimer = setTimeout(() => setRetryNonce((value) => value + 1), 2_000);
      });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [retryNonce]);

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
            onClick={() => setRetryNonce((value) => value + 1)}
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40 transition hover:text-white/75"
          >
            Retry now
          </button>
        </section>
      </main>
    );
  }
  if (!viewerToken) return <main aria-label="Initializing Jarvis" className="min-h-screen bg-black" />;
  const auth = { token: viewerToken, refresh: refreshViewerToken };
  return (
    <ViewerAuthContext.Provider value={auth}>
      <ViewerSessionProvider token={viewerToken}>
        <ConvexProviderWithAuth client={convex} useAuth={useJarvisConvexAuth}>
          {children}
        </ConvexProviderWithAuth>
      </ViewerSessionProvider>
    </ViewerAuthContext.Provider>
  );
}
