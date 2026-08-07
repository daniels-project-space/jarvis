"use client";

import { isGuestViewerSession, useViewerSession } from "@/lib/viewer-session";

export type CreationSourceFile = Readonly<{
  fileId: string;
  name: string;
}>;

function normalizedSources(files: readonly CreationSourceFile[] | null | undefined) {
  const seen = new Set<string>();
  const sources: CreationSourceFile[] = [];
  for (const source of files ?? []) {
    const fileId = String(source?.fileId ?? "").trim();
    const name = String(source?.name ?? "").trim().slice(0, 240);
    if (!fileId || !name || seen.has(fileId)) continue;
    seen.add(fileId);
    sources.push({ fileId, name });
    if (sources.length >= 32) break;
  }
  return sources;
}

/** Owner-only links to the private files that grounded a saved creation. */
export function CreationSourceFiles({
  files,
  maxVisible = 3,
  className = "",
}: {
  files?: readonly CreationSourceFile[] | null;
  maxVisible?: number;
  className?: string;
}) {
  const viewerToken = useViewerSession();
  const sources = normalizedSources(files);
  if (!viewerToken || isGuestViewerSession(viewerToken) || !sources.length) return null;

  const visible = sources.slice(0, Math.max(1, Math.min(6, Math.floor(maxVisible))));
  const remaining = sources.length - visible.length;

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}
      aria-label={`${sources.length} source file${sources.length === 1 ? "" : "s"}`}
    >
      <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.14em] text-slate/70">sources</span>
      <ul role="list" className="flex min-w-0 flex-wrap items-center gap-1">
        {visible.map((source) => {
          const path = `/api/files/${encodeURIComponent(source.fileId)}`;
          return (
            <li key={source.fileId} className="flex min-w-0 max-w-full items-center overflow-hidden rounded-full border border-cyan/15 bg-cyan/[0.045] text-[9px] text-cyan-dim">
              <a
                href={path}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open source ${source.name}`}
                title={`Open source file · ${source.name}`}
                className="flex min-h-7 min-w-0 max-w-44 items-center gap-1 px-2 py-1 transition hover:bg-cyan/[0.08] hover:text-cyan focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan"
              >
                <span aria-hidden="true">▤</span>
                <span className="truncate">{source.name}</span>
              </a>
              <a
                href={`${path}?download=1`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Download source ${source.name}`}
                title={`Download ${source.name}`}
                className="grid min-h-7 min-w-7 place-items-center border-l border-cyan/10 px-1.5 text-cyan/65 transition hover:bg-cyan/[0.1] hover:text-cyan focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan"
              >
                <span aria-hidden="true">↓</span>
              </a>
            </li>
          );
        })}
        {remaining > 0 && (
          <li className="rounded-full border border-white/8 bg-white/[0.025] px-2 py-1 text-[8px] text-slate" aria-label={`${remaining} more source files`}>
            +{remaining}
          </li>
        )}
      </ul>
    </div>
  );
}
