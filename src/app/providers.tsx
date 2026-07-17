"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useEffect, useState, type ReactNode } from "react";
import { resolveConvexUrl } from "@/lib/convex-url";
import { ViewerSessionProvider } from "@/lib/viewer-session";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL));

export default function Providers({ children }: { children: ReactNode }) {
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const [error, setError] = useState(false);

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
      return await fetch("/api/auth/viewer", { method: "POST", cache: "no-store" });
    };
    void initialize()
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        if (typeof payload.viewerToken !== "string") throw new Error("viewer capability missing");
        if (active) setViewerToken(payload.viewerToken);
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
  return (
    <ViewerSessionProvider token={viewerToken}>
      <ConvexProvider client={convex}>{children}</ConvexProvider>
    </ViewerSessionProvider>
  );
}
