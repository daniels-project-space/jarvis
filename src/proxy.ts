import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (pathname === "/login") return NextResponse.redirect(new URL("/", req.url));
  if (
    !pathname.startsWith("/api/")
    || pathname === "/api/auth/viewer"
    || pathname === "/api/auth/pair"
    || pathname === "/api/agent-tool"
  ) return NextResponse.next();

  const tokenHash = await adminSessionHash(req);
  if (await validateAdminSession(tokenHash)) return NextResponse.next();
  return NextResponse.json({ error: "trusted device required" }, { status: 401 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest).*)"],
};
