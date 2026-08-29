"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { CompactWorkSnapshot } from "@/lib/active-work";
import { useJarvisQuery } from "@/lib/secure-convex";
import {
  searchOrbSurfaces,
  searchSourceLabel,
  type OrbSearchCreation,
  type OrbSearchFile,
  type OrbSearchProject,
  type OrbSearchResult,
} from "@/lib/orb-quick-search";

export function OrbQuickSearch({
  owner,
  creations,
  projects,
  snapshot,
  hidden = false,
  onQueryChangeAction,
  onOpenAction,
  onShowAction,
}: {
  owner: boolean;
  creations: OrbSearchCreation[] | undefined;
  projects: OrbSearchProject[];
  snapshot: CompactWorkSnapshot;
  hidden?: boolean;
  onQueryChangeAction?: (query: string) => void;
  onOpenAction: (result: OrbSearchResult) => void;
  onShowAction: (result: OrbSearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const search = query.trim();
  const files = useJarvisQuery(
    api.files.quickSearchLibrary,
    owner && search.length >= 2 ? { search, limit: 10 } : "skip",
  ) as OrbSearchFile[] | undefined;
  const results = useMemo(
    () => searchOrbSurfaces(search, {
      creations,
      files,
      projects,
      jobs: snapshot.hierarchy.length
        ? snapshot.hierarchy.flatMap((mission) => mission.projects.flatMap((project) => project.jobs))
        : snapshot.fleet?.nodes ?? [],
    }),
    [creations, files, projects, search, snapshot],
  );
  const visible = active && search.length >= 2;
  const expanded = active || hovered || query.length > 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        setActive(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!owner || hidden) return null;

  return (
    <div
      data-orb-quick-search
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`pointer-events-auto absolute left-1/2 top-2 z-40 -translate-x-1/2 transition-[width] duration-200 ${expanded ? "w-[min(244px,calc(100%-72px))]" : "w-9"}`}
    >
      <div className={`flex h-9 items-center overflow-hidden rounded-full border bg-[#07131e]/70 px-[10px] shadow-[0_8px_22px_rgba(0,0,0,.22)] backdrop-blur-xl transition ${visible ? "border-cyan/55" : expanded ? "border-cyan/25" : "border-white/[.07] hover:border-cyan/30"}`}>
        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          aria-label="Search Jarvis work and files"
          className="grid h-4 w-4 shrink-0 place-items-center text-cyan/65 transition hover:text-cyan"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4 4" /></svg>
        </button>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            const next = event.target.value.slice(0, 120);
            setQuery(next);
            onQueryChangeAction?.(next);
          }}
          onFocus={() => setActive(true)}
          onBlur={() => window.setTimeout(() => setActive(false), 140)}
          type="search"
          role="combobox"
          aria-label="Search projects, saved work, and private files"
          aria-expanded={visible}
          aria-haspopup="listbox"
          aria-controls="orb-quick-search-results"
          placeholder="Search everything"
          tabIndex={expanded ? 0 : -1}
          className={`min-w-0 bg-transparent text-[10px] text-ice outline-none placeholder:text-slate/60 transition-all duration-200 ${expanded ? "ml-2 flex-1 opacity-100" : "pointer-events-none w-0 opacity-0"}`}
        />
      </div>
      {visible && (
        <div id="orb-quick-search-results" role="listbox" aria-label="Quick search results" className="mt-2 overflow-hidden rounded-2xl border border-white/10 bg-[#07131e]/[.98] p-1.5 shadow-[0_18px_52px_rgba(0,0,0,.48)] backdrop-blur-xl">
          {results.length ? results.map((result) => (
            <div key={result.id} role="option" aria-selected={false} aria-label={`${searchSourceLabel(result.source)}: ${result.title}`} className="group flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 transition hover:bg-cyan/[.07]">
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${result.source === "work" ? "bg-amber" : result.source === "project" ? "bg-cyan" : "bg-slate"}`} />
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenAction(result)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[10px] text-ice">{result.title}</span>
                <span className="mt-0.5 block truncate font-mono text-[7px] uppercase tracking-[.09em] text-slate">{searchSourceLabel(result.source)} · {result.detail}</span>
              </button>
              {result.canShow && (
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onShowAction(result)} className="shrink-0 rounded-lg border border-white/10 px-1.5 py-1 font-mono text-[7px] uppercase tracking-[.08em] text-slate opacity-0 transition hover:border-cyan/45 hover:text-cyan group-hover:opacity-100 focus:opacity-100" aria-label={`Show ${result.title} here`}>
                  show
                </button>
              )}
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenAction(result)} className="shrink-0 rounded-lg px-1.5 py-1 font-mono text-[7px] uppercase tracking-[.08em] text-cyan/75 transition hover:bg-cyan/[.1] hover:text-cyan" aria-label={`Open ${result.title}`}>
                open
              </button>
            </div>
          )) : (
            <p className="px-3 py-4 text-center text-[10px] text-slate">No matching project, saved work, or private file.</p>
          )}
        </div>
      )}
    </div>
  );
}
