"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { viewerFetch } from "@/lib/viewer-request";
import type { CompactWorkSnapshot } from "@/lib/active-work";
import {
  buildWorkMap,
  type WorkMapBranch,
  type WorkMapCategory,
  type WorkMapLeaf,
  type WorkMapTodoItem,
  type WorkMapTodoSummary,
  workMapActiveJobCount,
  workMapPosition,
} from "@/lib/work-map";

type WorkMapRequest = {
  openTodoCount?: unknown;
  ok?: unknown;
  todos?: unknown;
};

function todoItems(value: unknown): WorkMapTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || !row.text.trim()) return [];
    const tags = Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6)
      : undefined;
    return [{
      text: row.text.slice(0, 240),
      ...(typeof row.due === "string" ? { due: row.due.slice(0, 32) } : {}),
      ...(tags?.length ? { tags } : {}),
    }];
  });
}

function asTodoSummary(value: WorkMapRequest | null): WorkMapTodoSummary {
  if (value?.ok !== true || typeof value.openTodoCount !== "number" || !Number.isSafeInteger(value.openTodoCount)) {
    return { state: "unavailable", openTodoCount: null, items: [] };
  }
  return { state: "ready", openTodoCount: Math.max(0, value.openTodoCount), items: todoItems(value.todos) };
}

function branchWorking(branch: WorkMapBranch) {
  return branch.working || branch.children.some((child) => child.working);
}

function categoryWorking(category: WorkMapCategory) {
  return category.branches.some(branchWorking);
}

function categoryVisibleCount(category: WorkMapCategory) {
  return category.branches.reduce((count, branch) => count + (branch.children.length || 1), 0);
}

function actionLabel(action: WorkMapLeaf["action"]) {
  if (action === "documents") return "Open documents";
  if (action === "todos") return "Open to-do list";
  return "Open worker detail";
}

export function WorkMapBubble({
  snapshot,
  documentCount,
  hidden = false,
  owner,
  reduceMotion = false,
  initialOpen = false,
  onOpenChangeAction,
  onOpenDocumentsAction,
  onOpenTodosAction,
  onOpenWorkAction,
  onOpenAllWorkAction,
}: {
  snapshot: CompactWorkSnapshot;
  documentCount?: number;
  hidden?: boolean;
  owner: boolean;
  reduceMotion?: boolean;
  initialOpen?: boolean;
  onOpenChangeAction?: (open: boolean) => void;
  onOpenDocumentsAction: () => void;
  onOpenTodosAction: (items: WorkMapTodoItem[]) => void;
  onOpenWorkAction: (jobId: string) => void;
  onOpenAllWorkAction: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(initialOpen);
  const [expandedCategoryId, setExpandedCategoryId] = useState<string | null>(null);
  const [expandedBranchId, setExpandedBranchId] = useState<string | null>(null);
  const [todos, setTodos] = useState<WorkMapTodoSummary>({ state: "loading", openTodoCount: null, items: [] });
  const categories = useMemo(
    () => buildWorkMap(snapshot, { documentCount, todos }),
    [documentCount, snapshot, todos],
  );
  const expandedCategory = categories.find((category) => category.id === expandedCategoryId) ?? null;
  const expandedBranch = expandedCategory?.branches.find((branch) => branch.id === expandedBranchId) ?? null;

  const restoreTriggerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (trigger && trigger.getClientRects().length) trigger.focus();
    });
  }, []);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setExpandedCategoryId(null);
    setExpandedBranchId(null);
    onOpenChangeAction?.(false);
    if (restoreFocus) restoreTriggerFocus();
  }, [onOpenChangeAction, restoreTriggerFocus]);
  const openMap = () => {
    setOpen(true);
    onOpenChangeAction?.(true);
  };

  useEffect(() => {
    if (!hidden || !open) return;
    close(false);
  }, [close, hidden, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  useEffect(() => {
    if (!open || !owner) return;
    const controller = new AbortController();
    setTodos((current) => current.state === "ready" ? current : { state: "loading", openTodoCount: null, items: [] });
    void viewerFetch("/api/work-map/summary", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => asTodoSummary(await response.json().catch(() => null)))
      .then((summary) => {
        if (!controller.signal.aborted) setTodos(summary);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTodos({ state: "unavailable", openTodoCount: null, items: [] });
      });
    return () => controller.abort();
  }, [open, owner]);

  const runAction = (action: WorkMapLeaf["action"], jobId?: string) => {
    close(false);
    if (action === "documents") return onOpenDocumentsAction();
    if (action === "todos") return onOpenTodosAction(todos.items);
    if (jobId) onOpenWorkAction(jobId);
  };

  if (!owner || hidden) return null;

  if (!open) {
    // Project and domain branches intentionally show the same job in two useful
    // contexts, so the trigger must count durable jobs rather than map leaves.
    const activeCount = workMapActiveJobCount(snapshot);
    return (
      <button
        ref={triggerRef}
        type="button"
        data-work-map-trigger
        aria-expanded="false"
        aria-label={`Open Jarvis work map${activeCount ? `, ${activeCount} active worker ${activeCount === 1 ? "task" : "tasks"}` : ""}`}
        onClick={openMap}
        className="work-map-trigger glass absolute left-1/2 top-[68%] z-30 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full !border-cyan/25 bg-[#071019]/88 px-2.5 py-1.5 text-left shadow-[0_8px_24px_rgba(0,0,0,.3)] transition hover:-translate-y-px hover:!border-cyan/55 motion-reduce:hover:translate-y-0 motion-reduce:transition-none sm:left-auto sm:right-[calc(50%-184px)] sm:top-[61%] sm:translate-x-0"
      >
        <span className={`work-map-trigger-dot ${activeCount ? "work-map-pulse" : ""}`} aria-hidden="true" />
        <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-cyan">work map</span>
        {activeCount > 0 && <span className="font-mono text-[8px] text-ice">{activeCount}</span>}
      </button>
    );
  }

  const visibleCount = expandedCategory ? categoryVisibleCount(expandedCategory) : 0;
  const overflowCount = expandedCategory ? Math.max(0, expandedCategory.workCount - visibleCount) : 0;
  return (
    <section
      data-work-map
      id="jarvis-work-map"
      aria-label="Jarvis work map"
      className={`work-map-surface pointer-events-auto absolute left-1/2 top-1/2 z-30 h-[min(510px,76vh)] w-[min(820px,calc(100%-12px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px] bg-[radial-gradient(ellipse_at_50%_50%,rgba(6,16,24,.12),rgba(6,16,24,.05)_46%,transparent_78%)] motion-reduce:transition-none sm:w-[min(820px,calc(100%-28px))] ${reduceMotion ? "work-map-static" : ""}`}
    >
      <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {categories.map((category, index) => {
          const point = workMapPosition(index, categories.length);
          const active = categoryWorking(category);
          return <g key={category.id}>
            <line className={active ? "work-map-live-line" : "work-map-line"} x1="50" y1="50" x2={point.x} y2={point.y} />
            <circle className={active ? "work-map-live-anchor" : "work-map-anchor"} cx={point.x} cy={point.y} r="1.05" />
          </g>;
        })}
      </svg>

      <div className="pointer-events-none absolute left-1/2 top-1/2 z-0 grid h-[102px] w-[102px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-cyan/35 bg-cyan/[0.02] text-center shadow-[0_0_42px_rgba(34,211,238,.13)]">
        <div><div className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan">Jarvis</div><div className="mt-1 text-[10px] text-ice">work map</div></div>
      </div>

      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <div className="min-w-0"><div className="font-mono text-[8px] uppercase tracking-[0.18em] text-cyan">Live work topology</div><p className="mt-0.5 truncate text-[10px] text-slate">Open one branch at a time</p></div>
        <button ref={closeButtonRef} type="button" onClick={() => close()} className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.1em] text-slate transition hover:border-cyan/45 hover:text-cyan" aria-label="Close Jarvis work map">close</button>
      </header>

      <div className="absolute inset-0 z-10" aria-live="off">
        {categories.map((category, index) => {
          const point = workMapPosition(index, categories.length);
          const selected = expandedCategoryId === category.id;
          const active = categoryWorking(category);
          return <button
            key={category.id}
            type="button"
            data-work-map-category={category.id}
            aria-expanded={selected}
            aria-controls={selected ? "jarvis-work-map-branch" : undefined}
            onClick={() => {
              setExpandedCategoryId(selected ? null : category.id);
              setExpandedBranchId(null);
            }}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            className={`work-map-category absolute w-[min(98px,24vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border px-2 py-2 text-left transition-[background,border-color,box-shadow,transform] duration-300 motion-reduce:transition-none sm:w-[min(136px,28vw)] sm:px-2.5 ${
              selected ? "border-cyan/70 bg-cyan/[0.13] shadow-[0_0_22px_rgba(34,211,238,.18)]" : "border-white/10 bg-[#08131d]/86 hover:border-cyan/40 hover:bg-[#0b1b28]/94"
            }`}
          >
            <span className="flex min-w-0 items-center gap-1.5"><span className={`work-map-state-dot ${active ? "work-map-pulse" : ""}`} aria-hidden="true" /><span className="truncate font-mono text-[9px] uppercase tracking-[0.11em] text-ice">{category.label}</span></span>
            <span className="mt-1 block truncate text-[8px] text-slate">{category.workCount ? `${category.workCount} worker ${category.workCount === 1 ? "task" : "tasks"}` : category.detail}</span>
          </button>;
        })}
      </div>

      {expandedCategory && (
        <aside
          id="jarvis-work-map-branch"
          data-work-map-branch={expandedCategory.id}
          aria-label={`${expandedCategory.label} branch`}
          className="work-map-branch absolute inset-x-3 bottom-3 z-20 max-h-[34%] overflow-y-auto rounded-2xl border border-white/10 bg-[#07131e]/95 p-2.5 shadow-[0_12px_44px_rgba(0,0,0,.38)] sm:inset-x-[12%] sm:max-h-[42%]"
        >
          <header className="mb-2 flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><h2 className="truncate text-[11px] text-ice">{expandedCategory.label}</h2><p className="truncate text-[8px] text-slate">{expandedCategory.detail}</p></div><span className="font-mono text-[8px] text-cyan">{expandedCategory.workCount || "ready"}</span></header>
          <div className="grid gap-1 sm:grid-cols-2">
            {expandedCategory.branches.map((branch) => {
              const selected = expandedBranchId === branch.id;
              const working = branchWorking(branch);
              const isExpandable = branch.children.length > 0;
              const action = branch.action;
              return <div key={branch.id} className="min-w-0 rounded-xl border border-white/[0.07] bg-black/15 p-1.5">
                <button
                  type="button"
                  data-work-map-item={branch.id}
                  aria-expanded={isExpandable ? selected : undefined}
                  aria-label={`${isExpandable ? "Expand" : action ? actionLabel(action) : "Open"} ${branch.label}: ${branch.detail}`}
                  onClick={() => {
                    if (isExpandable) {
                      setExpandedBranchId(selected ? null : branch.id);
                    } else if (action) {
                      runAction(action, branch.jobId);
                    }
                  }}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-white/[0.05]"
                >
                  <span className={`work-map-state-dot shrink-0 ${working ? "work-map-pulse" : ""}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[10px] text-ice">{branch.label}</span><span className="mt-0.5 block truncate font-mono text-[7px] uppercase tracking-[0.08em] text-slate">{branch.detail}</span></span>
                  {isExpandable && <span className="font-mono text-[10px] text-cyan/65" aria-hidden="true">{selected ? "−" : "+"}</span>}
                </button>
                {selected && expandedBranch && expandedBranch.id === branch.id && (
                  <div data-work-map-leaves={branch.id} className="mt-1.5 space-y-1 border-t border-white/[0.07] pt-1.5">
                    {branch.children.map((leaf) => <button
                      key={leaf.id}
                      type="button"
                      data-work-map-leaf={leaf.id}
                      onClick={() => runAction(leaf.action, leaf.jobId)}
                      aria-label={`${actionLabel(leaf.action)}: ${leaf.label}. ${leaf.detail}`}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-cyan/[0.07]"
                    >
                      <span className={`work-map-worker-dot ${leaf.working ? "work-map-pulse" : ""}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[9px] text-ice">{leaf.label}</span><span className="block truncate font-mono text-[7px] text-slate">{leaf.detail}</span></span>
                      <span className="font-mono text-[7px] uppercase text-cyan/60">{leaf.working ? "working" : leaf.state}</span>
                    </button>)}
                    {branch.hiddenCount > 0 && <div data-work-map-overflow className="px-1 py-1 font-mono text-[8px] text-slate">+{branch.hiddenCount} more worker {branch.hiddenCount === 1 ? "task" : "tasks"}</div>}
                  </div>
                )}
              </div>;
            })}
          </div>
          {overflowCount > 0 && <button type="button" data-work-map-overflow onClick={() => { close(false); onOpenAllWorkAction(); }} className="mt-2 rounded-full border border-cyan/20 px-2.5 py-1 font-mono text-[8px] text-cyan transition hover:border-cyan/55">+{overflowCount} more active worker {overflowCount === 1 ? "task" : "tasks"} · open full work</button>}
        </aside>
      )}
      <span className="sr-only" aria-live="polite">{expandedCategory ? `${expandedCategory.label} branch is open.` : "Work map is open. Select a category."}</span>
    </section>
  );
}
