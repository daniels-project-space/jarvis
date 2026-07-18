import type { NextRequest } from "next/server";
import { adminSessionHash, controlQuery, validateAdminSession } from "@/lib/control-session";

export const runtime = "nodejs";
export const maxDuration = 30;

type Creation = {
  _id: string;
  kind: string;
  title: string;
  data?: string;
  url?: string;
  category?: string;
  folder?: string;
  project?: string;
  inquiry?: string;
  createdAt?: number;
  updatedAt?: number;
};

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

  if (row.url && /^https:\/\//i.test(row.url)) {
    const upstream = await fetch(row.url, { cache: "no-store", redirect: "follow" }).catch(() => null);
    if (upstream?.ok && upstream.body) {
      const type = upstream.headers.get("content-type") || (row.kind === "pdf" ? "application/pdf" : "application/octet-stream");
      const extension = row.kind === "pdf" ? "pdf" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg" : "bin";
      return attachment(upstream.body, `${base}.${extension}`, type);
    }
  }

  const source = sourceDownload(row);
  return attachment(source.body, `${base}.${source.extension}`, source.contentType);
}
