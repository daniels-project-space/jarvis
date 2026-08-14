import type { NextRequest } from "next/server";
import { adminSessionHash, controlQuery, validateAdminSession } from "@/lib/control-session";
import { markdownToPdf } from "@/lib/pdf";
import { privateR2Get } from "@/lib/private-r2";

export const runtime = "nodejs";
export const maxDuration = 30;

type Creation = {
  _id: string;
  kind: string;
  title: string;
  data?: string;
  url?: string;
  hasPrivateAsset?: boolean;
  category?: string;
  folder?: string;
  project?: string;
  inquiry?: string;
  createdAt?: number;
  updatedAt?: number;
};

type PrivateCreationMedia = {
  assetR2Key: string;
  assetContentType?: string;
  title: string;
  kind: string;
};

const LEGACY_PUBLIC_CREATION_ORIGIN = "https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev";

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

function attachment(body: BodyInit, filename: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function contentTypeAndExtension(
  type: string | null | undefined,
  kind: string,
): { contentType: string; extension: string } {
  const contentType = String(type ?? "").split(";", 1)[0].trim().toLowerCase()
    || (kind === "pdf" ? "application/pdf" : "application/octet-stream");
  const extension = kind === "pdf" || contentType === "application/pdf"
    ? "pdf"
    : contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("jpeg")
          ? "jpg"
          : contentType.includes("avif")
            ? "avif"
            : contentType.includes("gif")
              ? "gif"
              : contentType.includes("svg")
                ? "svg"
                : "bin";
  return { contentType, extension };
}

function trustedLegacyCreationUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== LEGACY_PUBLIC_CREATION_ORIGIN
      || url.username
      || url.password
      || url.search
      || url.hash
      || !url.pathname.startsWith("/creations/")
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sourceDownload(row: Creation): { body: string; extension: string; contentType: string } {
  const data = String(row.data ?? "");
  if (row.kind === "doc") return { body: data, extension: "md", contentType: "text/markdown; charset=utf-8" };
  if (row.kind === "board") {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(data);
    } catch {
      /* preserve a readable empty board bundle */
    }
    const bundle = {
      type: "excalidraw",
      version: 2,
      source: "Jarvis",
      elements: Array.isArray(doc.elements) ? doc.elements : [],
      appState: { viewBackgroundColor: "#eef4fb" },
      files: {},
      jarvis: {
        title: row.title,
        zones: doc.zones ?? {},
        imageUrls: doc.imageUrls ?? {},
        pendingOps: doc.pendingOps ?? [],
        project: row.project,
        inquiry: row.inquiry,
      },
    };
    return { body: JSON.stringify(bundle, null, 2), extension: "excalidraw", contentType: "application/json; charset=utf-8" };
  }
  const bundle = {
    type: row.kind,
    title: row.title,
    category: row.category,
    folder: row.folder,
    project: row.project,
    inquiry: row.inquiry,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    data: (() => {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    })(),
  };
  return { body: JSON.stringify(bundle, null, 2), extension: "json", contentType: "application/json; charset=utf-8" };
}

export async function GET(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) return Response.json({ error: "missing creation id" }, { status: 400 });

  const row = (await controlQuery("creations:get", { id, authTokenHash }).catch(() => null)) as Creation | null;
  if (!row) return Response.json({ error: "creation not found" }, { status: 404 });
  const base = safeName(row.title);
  const format = req.nextUrl.searchParams.get("format")?.trim().toLowerCase();

  // PDF is synthesized on demand from the doc's markdown source — it is never
  // stored, so this branch runs before the binary asset branch (which docs
  // don't populate anyway) and before the default raw-markdown behavior.
  if (row.kind === "doc" && format === "pdf") {
    const bytes = await markdownToPdf(row.title, String(row.data ?? ""));
    return attachment(bytes as unknown as BodyInit, `${base}.pdf`, "application/pdf");
  }

  if (row.hasPrivateAsset) {
    const media = (await controlQuery("creations:getForMedia", { id, authTokenHash }).catch(() => null)) as PrivateCreationMedia | null;
    if (!media) return Response.json({ error: "creation asset unavailable" }, { status: 404 });
    const upstream = await privateR2Get(media.assetR2Key).catch(() => null);
    if (upstream?.ok && upstream.body) {
      const stored = contentTypeAndExtension(upstream.headers.get("content-type") || media.assetContentType, media.kind);
      return attachment(upstream.body, `${safeName(media.title)}.${stored.extension}`, stored.contentType);
    }
    return Response.json({ error: "creation asset unavailable" }, { status: upstream?.status === 404 ? 404 : 502 });
  }

  // Existing public objects are retained for compatibility, but only the
  // historical Jarvis R2 origin is ever fetched. This closes an SSRF path in
  // old rows while the new private storage route takes over all new writes.
  const legacyUrl = trustedLegacyCreationUrl(row.url);
  if (legacyUrl) {
    const upstream = await fetch(legacyUrl, { cache: "no-store", redirect: "error" }).catch(() => null);
    if (upstream?.ok && upstream.body) {
      const media = contentTypeAndExtension(upstream.headers.get("content-type"), row.kind);
      return attachment(upstream.body, `${base}.${media.extension}`, media.contentType);
    }
  }

  const source = sourceDownload(row);
  return attachment(source.body, `${base}.${source.extension}`, source.contentType);
}
