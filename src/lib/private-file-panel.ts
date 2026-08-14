/**
 * Canonical presentation gate for private uploads.  A panel may only ever
 * receive a same-origin owner route, never a storage key or arbitrary URL.
 */
export type PrivateFilePanelCandidate = {
  fileId: string;
  name?: string;
  relativePath?: string;
  mimeType?: string;
  status?: string;
};

export type PrivateFilePanel = {
  type: "image" | "private_video" | "private_pdf";
  value: string;
  title: string;
  kind: "image" | "video" | "PDF";
};

const READY_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const READY_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const READY_PDF_MIME_TYPES = new Set(["application/pdf"]);

function panelTitle(file: PrivateFilePanelCandidate): string {
  const raw = String(file.relativePath || file.name || "Uploaded file").trim();
  return (raw.replace(/\s+/g, " ").slice(0, 120) || "Uploaded file");
}

/**
 * Returns the one safe renderer for a ready, detected private visual file.
 * Audio and arbitrary documents remain downloadable/reference-only until they
 * have their own native private viewer, rather than being routed through an
 * iframe or a public URL.
 */
export function readyPrivateFilePanel(file: PrivateFilePanelCandidate): PrivateFilePanel | null {
  if (file.status !== "ready") return null;
  const fileId = String(file.fileId ?? "").trim();
  if (!fileId) return null;
  const mimeType = String(file.mimeType ?? "").trim().toLowerCase();
  const value = `/api/files/${encodeURIComponent(fileId)}`;
  const title = panelTitle(file);
  if (READY_IMAGE_MIME_TYPES.has(mimeType)) return { type: "image", value, title, kind: "image" };
  if (READY_VIDEO_MIME_TYPES.has(mimeType)) return { type: "private_video", value, title, kind: "video" };
  if (READY_PDF_MIME_TYPES.has(mimeType)) return { type: "private_pdf", value, title, kind: "PDF" };
  return null;
}
