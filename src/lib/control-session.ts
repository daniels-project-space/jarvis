import type { NextRequest } from "next/server";

export const ADMIN_COOKIE = "jarvis_admin";
export const ADMIN_SESSION_SECONDS = 30 * 24 * 60 * 60;

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function adminSessionHash(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  return token ? await sha256Hex(token) : null;
}

export async function validateAdminSession(tokenHash: string | null): Promise<boolean> {
  if (!tokenHash) return false;
  try {
    const response = await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "controlAuth:validateSession", args: { tokenHash }, format: "json" }),
      cache: "no-store",
    });
    const payload = await response.json();
    return response.ok && payload?.value === true;
  } catch {
    return false;
  }
}

export async function controlMutation(path: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") throw new Error("Control request was rejected");
  return payload.value;
}
