"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { resolveConvexUrl } from "@/lib/convex-url";
import { ViewerSessionProvider } from "@/lib/viewer-session";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL));

export default function Providers({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const [ready, setReady] = useState(pathname === "/login");

  useEffect(() => {
    if (pathname === "/login") {
      setReady(true);
      return;
    }
    let active = true;
    void fetch("/api/auth/viewer", { method: "POST", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        if (active && typeof payload.viewerToken === "string") setViewerToken(payload.viewerToken);
      })
      .catch(() => {
        if (active) window.location.assign(`/login?next=${encodeURIComponent(pathname || "/")}`);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => { active = false; };
  }, [pathname]);

  if (pathname === "/login") return <>{children}</>;
  if (!ready || !viewerToken) return <main aria-label="Loading private work system" className="min-h-screen bg-black" />;
  return (
    <ViewerSessionProvider token={viewerToken}>
      <ConvexProvider client={convex}>{children}</ConvexProvider>
    </ViewerSessionProvider>
  );
}
