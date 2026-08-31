import type { NextRequest } from "next/server";
import { adminSessionHash, controlQuery, validateAdminSession } from "@/lib/control-session";
import { fetchTrustedLegacyCreation, trustedLegacyCreationUrl } from "@/lib/legacy-creation-url";
import { markdownToPdf } from "@/lib/pdf";
import { privateCreationAssetGet } from "@/lib/private-creation-asset-store";

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
  assetStore: "private-r2-v1" | "private-r2-v2";
  assetLocator: string;
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
    const media = (await controlQuery("creations:getForMedia", { id, authTokenHash }).catch(() => null)) as CreationMedia | null;
    if (!media || !("assetStore" in media)) return Response.json({ error: "creation asset unavailable" }, { status: 404 });
    const upstream = await privateCreationAssetGet({ assetStore: media.assetStore, assetLocator: media.assetLocator }).catch(() => null);
    if (upstream?.ok && upstream.body) {
      const stored = contentTypeAndExtension(upstream.headers.get("content-type") || media.assetContentType, media.kind);
      return attachment(upstream.body, `${safeName(media.title)}.${stored.extension}`, stored.contentType);
    }
    return Response.json({ error: "creation asset unavailable" }, { status: upstream?.status === 404 ? 404 : 502 });
  }

  // Historical public objects are retained for compatibility, but their raw
  // URL is only returned by the server-only media query. Newer viewer records
  // contain the authenticated first-party proxy URL instead, so use the same
  // protected lookup as previews before falling back to old data shapes.
  const media = (await controlQuery("creations:getForMedia", { id, authTokenHash }).catch(() => null)) as CreationMedia | null;
  const legacyMedia = media && "legacyUrl" in media ? media : null;
  const legacyUrl = legacyMedia?.legacyUrl ?? trustedLegacyCreationUrl(row.url);
  if (legacyUrl) {
    const upstream = await fetchTrustedLegacyCreation(legacyUrl);
    if (upstream?.ok && upstream.body) {
      const stored = contentTypeAndExtension(upstream.headers.get("content-type"), legacyMedia?.kind ?? row.kind);
      return attachment(upstream.body, `${safeName(legacyMedia?.title ?? row.title)}.${stored.extension}`, stored.contentType);
    }
    if (legacyMedia) {
      return Response.json({ error: "creation asset unavailable" }, {
        status: upstream?.status === 404 ? 404 : upstream?.status === 413 ? 413 : upstream?.status === 416 ? 416 : 502,
      });
    }
  }

  const source = sourceDownload(row);
  return attachment(source.body, `${base}.${source.extension}`, source.contentType);
}
