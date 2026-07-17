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

async function requestViewerToken(): Promise<string> {
  const response = await fetch("/api/auth/viewer", { method: "POST", cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  const payload = await response.json();
  if (typeof payload.viewerToken !== "string") throw new Error("viewer capability missing");
  return payload.viewerToken;
}

function useJarvisConvexAuth() {
  const auth = useContext(ViewerAuthContext);
  return useMemo(() => ({
    isLoading: auth === null,
    isAuthenticated: auth !== null,
    fetchAccessToken: async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (!auth) return null;
      return forceRefreshToken ? await auth.refresh() : auth.token;
    },
  }), [auth]);
}

export default function Providers({ children }: { children: ReactNode }) {
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const refreshViewerToken = useCallback(async () => {
    const token = await requestViewerToken();
    setViewerToken(token);
    return token;
  }, []);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      const pairingToken = new URLSearchParams(window.location.hash.slice(1)).get("pair");
      if (pairingToken) {
        const paired = await fetch("/api/auth/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingToken }),
          cache: "no-store",
        });
        if (!paired.ok) throw new Error("pairing rejected");
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }
      return await requestViewerToken();
    };
    void initialize()
      .then((token) => {
        if (active) setViewerToken(token);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => { active = false; };
  }, []);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black px-6 text-center font-mono text-xs uppercase tracking-[0.16em] text-amber">
        This browser is not paired with Jarvis. Existing trusted devices stay signed in automatically.
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
