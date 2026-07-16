import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const tokenHash = await adminSessionHash(req);
  const authenticated = await validateAdminSession(tokenHash);

  if (pathname === "/login") {
    return authenticated ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  }
  if (authenticated) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "authentication required" }, { status: 401 });

  const login = new URL("/login", req.url);
  login.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|api/auth/login|api/auth/logout).*)",
  ],
};
