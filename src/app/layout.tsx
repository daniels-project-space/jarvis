import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Chakra_Petch, Sora, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import { ADMIN_COOKIE } from "@/lib/control-session";
import {
  getInitialOwnerViewerSession,
  requestOriginFromHeaders,
} from "@/lib/owner-viewer-bootstrap";

// A viewer JWT carries the authenticated Convex identity and is personalized to
// a validated owner session, so this layout must never be cached as static HTML.
export const dynamic = "force-dynamic";

const chakra = Chakra_Petch({
  variable: "--font-chakra",
  weight: ["400", "600", "700"],
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JARVIS",
  description: "Daniel's personal AI",
};

export const viewport: Viewport = {
  themeColor: "#05070d",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const ownerCookie = cookieStore.get(ADMIN_COOKIE)?.value;
  const initialViewerSession = await getInitialOwnerViewerSession(ownerCookie, {
    origin: requestHeaders.get("origin"),
    fetchSite: requestHeaders.get("sec-fetch-site"),
    requestOrigin: requestOriginFromHeaders(requestHeaders),
  });
  return (
    <html lang="en" className={`${chakra.variable} ${sora.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <div className="hud-grid pointer-events-none fixed inset-0" aria-hidden />
        <Providers
          initialViewerToken={initialViewerSession?.token}
          initialViewerTokenExpiresAt={initialViewerSession?.expiresAt}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
