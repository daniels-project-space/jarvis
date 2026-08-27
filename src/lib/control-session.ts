import type { NextRequest } from "next/server";
import { resolveConvexUrl } from "./convex-url";

export const ADMIN_COOKIE = "__Host-jarvis_admin";
export const LEGACY_ADMIN_COOKIE = "jarvis_admin";
export const ADMIN_SESSION_SECONDS = 365 * 24 * 60 * 60;

export type AdminSessionStatus =
  | { valid: true; expiresAt: number }
  | { valid: false; unavailable?: false }
  | { valid: false; unavailable: true };

const CONVEX_URL = resolveConvexUrl(process.env.CONVEX_URL, process.env.NEXT_PUBLIC_CONVEX_URL);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function adminSessionHash(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  return token ? await sha256Hex(token) : null;
}

export function isSameOriginRequest(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === req.nextUrl.origin;
  const fetchSite = req.headers.get("sec-fetch-site");
  return fetchSite === "same-origin" || fetchSite === "none";
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

export async function adminSessionStatus(
  tokenHash: string | null,
  signal?: AbortSignal,
): Promise<AdminSessionStatus> {
  if (!tokenHash) return { valid: false };
  try {
    const response = await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "controlAuth:sessionStatus", args: { tokenHash }, format: "json" }),
      cache: "no-store",
      signal,
    });
    const payload = await response.json();
    if (!response.ok || payload?.status === "error") return { valid: false, unavailable: true };
    const value = payload?.value;
    return response.ok && value?.valid === true
      ? { valid: true, expiresAt: Number(value.expiresAt) }
      : { valid: false };
  } catch {
    // A temporary Convex/network outage is not evidence that Daniel's device
    // lost enrollment. Let the client retry instead of rendering a lock screen.
    return { valid: false, unavailable: true };
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

export async function controlQuery(path: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") throw new Error("Control request was rejected");
  return payload.value;
}
