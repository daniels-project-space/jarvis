import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { canonicalJarvisRedirect } from "@/lib/canonical-origin";
import { bearerToken } from "@/lib/request-auth";
import { verifyViewerToken } from "@/lib/viewer-jwt";
import { isJarvisPublicPath } from "@/lib/public-path";

export async function proxy(req: NextRequest) {
  const canonical = canonicalJarvisRedirect({
    requestUrl: req.url,
    requestHost: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    vercelEnvironment: process.env.VERCEL_ENV,
    canonicalHost: process.env.JARVIS_CANONICAL_HOST ?? process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
  if (canonical) return NextResponse.redirect(canonical, 308);

  const pathname = req.nextUrl.pathname;
  if (pathname === "/login") return NextResponse.redirect(new URL("/", req.url));
  if (pathname === "/embed") {
    const response = NextResponse.next();
    // Jarvis is Daniel's open personal surface now. Host metadata still scopes
    // postMessage traffic inside the client, but it must never block the overlay
    // itself or impose a frame-ancestor access filter.
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  if (isJarvisPublicPath(pathname)) return NextResponse.next();

  if (await verifyViewerToken(bearerToken(req.headers.get("authorization")))) return NextResponse.next();
  const tokenHash = await adminSessionHash(req);
  if (await validateAdminSession(tokenHash)) return NextResponse.next();
  return NextResponse.json({ error: "Jarvis session required" }, { status: 401 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest).*)"],
};
