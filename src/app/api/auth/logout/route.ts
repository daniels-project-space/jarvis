import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminSessionHash, controlMutation } from "@/lib/control-session";

export async function POST(req: NextRequest) {
  const tokenHash = await adminSessionHash(req);
  if (tokenHash) await controlMutation("controlAuth:revokeSession", { tokenHash }).catch(() => false);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
