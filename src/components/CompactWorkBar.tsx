"use client";

import type { CompactWorkItem } from "../lib/active-work";

export function CompactWorkBar({
  work,
  hidden = false,
  onOpen,
}: {
  work: CompactWorkItem | null;
  hidden?: boolean;
  onOpen?: () => void;
}) {
  if (!work || hidden) return null;
  const percent = Math.max(0, Math.min(100, work.percent));

  return (
    <aside
      data-compact-work-bar
      data-work-id={work.id}
      aria-live="polite"
      className="absolute left-1/2 top-2 z-30 w-[min(420px,calc(100%-16px))] -translate-x-1/2"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open live detail for ${work.label}`}
        className="glass group grid h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-full !border-cyan/25 bg-[#071019]/90 px-3 text-left shadow-[0_8px_30px_rgba(0,0,0,.28)] transition-colors hover:!border-cyan/45"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full bg-cyan ${work.status === "running" ? "animate-pulse" : ""}`}
        />
        <span className="min-w-0">
          <span className="block truncate text-[11px] text-ice">{work.label}</span>
          <span className="block truncate font-mono text-[8px] uppercase tracking-[0.12em] text-cyan/65">
            {work.stage}
          </span>
        </span>
        <span className="font-mono text-[9px] tabular-nums text-cyan">{percent}%</span>
        <span aria-hidden="true" className="absolute inset-x-3 bottom-0.5 h-px overflow-hidden rounded-full bg-white/[0.06]">
          <span
            className="block h-full bg-gradient-to-r from-cyan/50 to-cyan transition-[width] duration-700"
            style={{ width: `${percent}%` }}
          />
        </span>
      </button>
    </aside>
  );
}
