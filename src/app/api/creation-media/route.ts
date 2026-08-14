import type { NextRequest } from "next/server";
import { adminSessionHash, controlQuery, validateAdminSession } from "@/lib/control-session";
import { fetchTrustedLegacyCreation } from "@/lib/legacy-creation-url";
import { privateR2Get } from "@/lib/private-r2";

export const runtime = "nodejs";
export const maxDuration = 30;

type PrivateCreationMedia = {
  assetR2Key: string;
  assetContentType?: string;
  title: string;
  kind: string;
};
type LegacyCreationMedia = {
  legacyUrl: string;
  title: string;
  kind: string;
};
type CreationMedia = PrivateCreationMedia | LegacyCreationMedia;

function safeName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._ -]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 90) || "jarvis-creation"
  );
}

function safeMediaType(value: string | null | undefined): string {
  const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return /^(?:image\/(?:avif|gif|jpeg|png|webp|svg\+xml)|application\/pdf)$/.test(type)
    ? type
    : "application/octet-stream";
}

function extensionFor(type: string, kind: string): string {
  if (type === "application/pdf" || kind === "pdf") return "pdf";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/jpeg") return "jpg";
  if (type === "image/avif") return "avif";
  if (type === "image/gif") return "gif";
  if (type === "image/svg+xml") return "svg";
  return "bin";
}

export async function GET(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) return Response.json({ error: "missing creation id" }, { status: 400 });
  const variant = req.nextUrl.searchParams.get("variant") ?? "asset";
  if (variant !== "asset" && variant !== "thumb") {
    return Response.json({ error: "unsupported media variant" }, { status: 400 });
  }

  const row = (await controlQuery("creations:getForMedia", { id, authTokenHash }).catch(() => null)) as CreationMedia | null;
  if (!row) return Response.json({ error: "creation media not found" }, { status: 404 });

  const range = req.headers.get("range") ?? undefined;
  const upstream = "assetR2Key" in row
    ? await privateR2Get(row.assetR2Key, range).catch(() => null)
    : await fetchTrustedLegacyCreation(row.legacyUrl, range);
  if (!upstream || !upstream.ok || !upstream.body) {
    return Response.json({ error: "creation media unavailable" }, {
      status: upstream?.status === 404 ? 404 : upstream?.status === 413 ? 413 : upstream?.status === 416 ? 416 : 502,
    });
  }

  const contentType = safeMediaType(
    upstream.headers.get("content-type") || ("assetContentType" in row ? row.assetContentType : undefined),
  );
  const filename = `${safeName(row.title)}.${extensionFor(contentType, row.kind)}`;
  const download = req.nextUrl.searchParams.get("download") === "1";
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `${download || contentType === "application/octet-stream" ? "attachment" : "inline"}; filename="${filename}"`,
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  // SVG can originate from a saved remote image. Make that one inline preview
  // inert without applying a sandbox policy to the browser's native PDF viewer.
  if (contentType === "image/svg+xml") {
    headers.set("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  }
  for (const name of ["content-length", "content-range", "accept-ranges"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
