import type { FleetNode } from "./active-work";

export type OrbSearchSource = "project" | "work" | "creation" | "file";

export type OrbSearchResult = {
  id: string;
  source: OrbSearchSource;
  title: string;
  detail: string;
  /** The original safe metadata is kept client-side so an action can use an
   * existing panel or authenticated file route; it never contains a storage key. */
  payload: Record<string, unknown>;
  canShow: boolean;
  score: number;
};

export type OrbSearchCreation = {
  _id: string;
  title: string;
  kind: string;
  category: string;
  folder: string;
  project?: string;
  data?: string;
  url?: string;
};

export type OrbSearchFile = {
  fileId: string;
  name: string;
  relativePath?: string;
  mimeType?: string;
  status?: string;
  summary?: string;
};

export type OrbSearchProject = {
  slug: string;
  name: string;
  status?: string;
  summary?: string;
  purpose?: string;
  productionUrl?: string;
};

export type OrbSearchInput = {
  creations?: OrbSearchCreation[];
  files?: OrbSearchFile[];
  projects?: OrbSearchProject[];
  jobs?: FleetNode[];
};

const WORD = /[a-z0-9][a-z0-9-]{1,}/gi;
const SOURCE_ORDER: Record<OrbSearchSource, number> = {
  project: 0,
  work: 1,
  creation: 2,
  file: 3,
};

function terms(value: string) {
  return [...new Set((value.toLowerCase().match(WORD) ?? []).filter((term) => term.length > 1))].slice(0, 8);
}

function rank(query: string, title: string, detail: string) {
  const normalizedTitle = title.toLowerCase();
  const normalizedDetail = detail.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  let score = normalizedTitle.startsWith(normalizedQuery) ? 120 : normalizedTitle.includes(normalizedQuery) ? 70 : normalizedDetail.includes(normalizedQuery) ? 25 : 0;
  for (const term of terms(normalizedQuery)) {
    if (normalizedTitle.includes(term)) score += 18;
    if (normalizedDetail.includes(term)) score += 6;
  }
  return score;
}

function visualFile(file: OrbSearchFile) {
  const mime = String(file.mimeType ?? "").toLowerCase();
  return file.status === "ready" && (
    mime === "image/jpeg" || mime === "image/png" || mime === "image/webp"
    || mime === "video/mp4" || mime === "video/quicktime" || mime === "video/webm"
    || mime === "application/pdf"
  );
}

/**
 * Small, deterministic search projection for the Jarvis surfaces the owner
 * can already open. It ranks only display-safe metadata and intentionally
 * keeps the dropdown short so it behaves like a command palette, not a second
 * project browser.
 */
export function searchOrbSurfaces(query: string, input: OrbSearchInput, limit = 7): OrbSearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const results: OrbSearchResult[] = [];

  for (const project of input.projects ?? []) {
    const detail = [project.status, project.summary, project.purpose, project.slug].filter(Boolean).join(" · ");
    const score = rank(trimmed, project.name, detail);
    if (score) results.push({
      id: `project:${project.slug}`,
      source: "project",
      title: project.name,
      detail: project.status || project.slug,
      payload: project,
      canShow: false,
      score,
    });
  }

  for (const job of input.jobs ?? []) {
    const detail = [job.repository, job.stage, job.progress, job.state].filter(Boolean).join(" · ");
    const score = rank(trimmed, job.label, detail);
    if (score) results.push({
      id: `work:${job.jobId}`,
      source: "work",
      title: job.label,
      detail: job.progress || job.stage || job.state,
      payload: { jobId: job.jobId },
      canShow: false,
      score: score + (job.state === "running" ? 8 : 0),
    });
  }

  for (const creation of input.creations ?? []) {
    const detail = [creation.folder, creation.category, creation.project, creation.kind].filter(Boolean).join(" · ");
    const score = rank(trimmed, creation.title, detail);
    if (score) results.push({
      id: `creation:${creation._id}`,
      source: "creation",
      title: creation.title,
      detail: creation.folder || creation.category,
      payload: creation,
      canShow: true,
      score,
    });
  }

  for (const file of input.files ?? []) {
    const detail = [file.relativePath, file.summary, file.mimeType, file.status].filter(Boolean).join(" · ");
    const score = rank(trimmed, file.name, detail);
    if (score) results.push({
      id: `file:${file.fileId}`,
      source: "file",
      title: file.name,
      detail: file.relativePath || file.status || "private file",
      payload: file,
      canShow: visualFile(file),
      score,
    });
  }

  const perSource = new Map<OrbSearchSource, number>();
  return results
    .sort((left, right) => right.score - left.score || SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.title.localeCompare(right.title))
    .filter((result) => {
      const used = perSource.get(result.source) ?? 0;
      // A single source should never turn this into a noisy file browser.
      if (used >= 3) return false;
      perSource.set(result.source, used + 1);
      return true;
    })
    .slice(0, Math.max(1, Math.min(10, limit)));
}

export function searchSourceLabel(source: OrbSearchSource) {
  return source === "project" ? "project" : source === "work" ? "work" : source === "creation" ? "saved" : "file";
}
