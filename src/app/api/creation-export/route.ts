import type { NextRequest } from "next/server";
import {
  adminSessionHash,
  controlMutation,
  controlQuery,
  isSameOriginRequest,
  validateAdminSession,
} from "@/lib/control-session";
import { creationMediaUrl, putPrivateCreationAsset } from "@/lib/creation-assets";
import { writePrivateCreationAssetWithRecord } from "@/lib/private-creation-asset-write";

// Client-rendered board exports (PNG/SVG) land here: Excalidraw can only
// rasterize its scene in the browser, so BoardView renders the bytes and
// posts them up to get a private R2 object, an owned library artifact, and a
// chat card with a first-party authenticated media/download route.
export const runtime = "nodejs";
export const maxDuration = 30;

// Vercel's Node serverless functions cap request bodies well under 4.5MB;
// stay comfortably inside that regardless of deploy target.
const MAX_BYTES = 4 * 1024 * 1024;

type Creation = {
  _id: string;
  kind: string;
  title: string;
  category?: string;
  folder?: string;
  project?: string;
  inquiry?: string;
  threadId?: string;
};

function privateCreationAssetLifecycle(authTokenHash: string) {
  return {
    reserve: async (assetR2Key: string, writerEpoch: string) => await controlMutation("creationAssetCleanup:reserve", { assetR2Key, writerEpoch, authTokenHash }),
    renewForWrite: async (assetR2Key: string, writerEpoch: string) => await controlMutation("creationAssetCleanup:renewForWrite", { assetR2Key, writerEpoch, authTokenHash }),
    markWritten: async (assetR2Key: string, writerEpoch: string) => await controlMutation("creationAssetCleanup:markWritten", { assetR2Key, writerEpoch, authTokenHash }),
    abandon: async (assetR2Key: string, writerEpoch: string) => await controlMutation("creationAssetCleanup:abandon", { assetR2Key, writerEpoch, authTokenHash }),
    complete: async (assetR2Key: string) => await controlMutation("creationAssetCleanup:complete", { assetR2Key, authTokenHash }),
    findCreationByAssetR2Key: async (assetR2Key: string) => await controlQuery("creations:getByAssetR2Key", { assetR2Key, authTokenHash }),
  };
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ error: "cross-origin export rejected" }, { status: 403 });
  }
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("creationId")?.trim();
  const format = req.nextUrl.searchParams.get("format")?.trim().toLowerCase();
  if (!id) return Response.json({ error: "missing creation id" }, { status: 400 });
  if (format !== "png" && format !== "svg") return Response.json({ error: "unsupported format" }, { status: 400 });

  const row = (await controlQuery("creations:get", { id, authTokenHash }).catch(() => null)) as Creation | null;
  if (!row) return Response.json({ error: "creation not found" }, { status: 404 });
  if (row.kind !== "board") return Response.json({ error: "only board exports are supported" }, { status: 400 });

  const bytes = Buffer.from(await req.arrayBuffer());
  if (!bytes.length) return Response.json({ error: "empty export" }, { status: 400 });
  if (bytes.byteLength > MAX_BYTES) return Response.json({ error: "export too large" }, { status: 413 });

  const contentType = format === "png" ? "image/png" : "image/svg+xml";
  const saved = await writePrivateCreationAssetWithRecord({
    writeAsset: async (assetId, beforeR2Write) => await putPrivateCreationAsset(bytes, contentType, "asset", assetId, { beforeR2Write }),
    persistCreation: async (asset, assetWriteEpoch) => await controlMutation("creations:create", {
      kind: "export",
      title: `${row.title || "Board"} · ${format.toUpperCase()} export`,
      assetR2Key: asset.key,
      assetContentType: asset.contentType,
      assetWriteEpoch,
      data: JSON.stringify({ sourceCreationId: row._id, format, contentType }),
      category: "exports",
      folder: row.folder ? `${row.folder} / Exports` : "Exports",
      project: row.project,
      inquiry: row.inquiry,
      threadId: row.threadId,
      authTokenHash,
    }),
    lifecycle: privateCreationAssetLifecycle(authTokenHash),
  });
  if (!saved.ok) {
    const message = saved.stage === "asset_write"
      ? "private R2 upload failed"
      : "export persistence could not be verified; private storage is queued for safe recovery";
    return Response.json({ error: message }, { status: 502 });
  }
  const exportCreationId = saved.creationId;

  const url = creationMediaUrl(exportCreationId);
  // A PNG is a useful current board thumbnail, while each PNG/SVG remains an
  // independent immutable library item rather than overwriting prior exports.
  // The parent only stores the authenticated first-party display route, never
  // a private key or public bucket URL.
  if (format === "png") {
    await controlMutation("creations:update", { id, thumb: url, authTokenHash }).catch(() => undefined);
  }

  const downloadUrl = `/api/creation-download?id=${encodeURIComponent(exportCreationId)}`;
  let chatPosted = true;
  try {
    await controlMutation("chatQueue:postCard", {
      threadId: row.threadId,
      type: "image",
      value: url,
      title: `${row.title || "Board"} · ${format.toUpperCase()} export`,
      downloadUrl,
      authTokenHash,
    });
  } catch {
    // The export itself is still safely saved in the library. Make that
    // degraded state explicit to the client instead of pretending it appeared
    // in chat.
    chatPosted = false;
  }

  return Response.json({ url, creationId: exportCreationId, downloadUrl, chatPosted });
}
