"use client";

import { useEffect, useMemo, useState } from "react";
import { needsDaniel, relevantActiveWork, type ActiveWork } from "@/lib/active-work";

type CommandJob = ActiveWork & {
  _id: string;
  status: string;
  task: string;
  progress?: string;
  percent?: number;
  heartbeatAt?: number;
  startedAt?: number;
};

type CommandDeckProps = {
  busy: boolean;
  snapshot?: { active?: CommandJob[] } | null;
  selectedJobId: string | null;
  onSelectJob: (id: string) => void;
};

const AGENT_NAMES: Record<string, string> = {
  jarvis: "JARVIS",
  paul: "Paul",
  atlas: "Atlas",
  iris: "Iris",
  maya: "Maya",
  sentry: "Sentry",
};

function age(at?: number) {
  if (!at) return "now";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function Dot({ tone = "cyan", pulse = false }: { tone?: "cyan" | "amber" | "slate"; pulse?: boolean }) {
  const color = tone === "amber" ? "bg-amber" : tone === "slate" ? "bg-slate-500" : "bg-cyan";
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-45 ${color}`} />}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

function useSoftPresence(show: boolean) {
  const [mounted, setMounted] = useState(show);
  const [visible, setVisible] = useState(show);
  useEffect(() => {
    let frame = 0;
    let revealFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    frame = requestAnimationFrame(() => {
      if (show) {
        setMounted(true);
        revealFrame = requestAnimationFrame(() => setVisible(true));
      } else {
        setVisible(false);
        timer = setTimeout(() => setMounted(false), 280);
      }
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (revealFrame) cancelAnimationFrame(revealFrame);
      if (timer) clearTimeout(timer);
    };
  }, [show]);
  return { mounted, visible };
}

export default function CommandDeck({ busy, snapshot, selectedJobId, onSelectJob }: CommandDeckProps) {
  // Start compact on every viewport. The old post-mount mobile collapse was the
  // visible flash at the top of the app.
  const [collapsed, setCollapsed] = useState(true);
  const [acting, setActing] = useState("");
  const active = useMemo(() => relevantActiveWork(snapshot?.active ?? [], 4), [snapshot?.active]);
  const decisions = active.filter(needsDaniel);
  const running = active.filter((job) => job.status === "running");
  const shouldShow = busy || active.length > 0;
  const presence = useSoftPresence(shouldShow);

  useEffect(() => {
    if (shouldShow) return;
    const timer = setTimeout(() => setCollapsed(true), 300);
    return () => clearTimeout(timer);
  }, [shouldShow]);

  // The expanded work picker and the selected worker terminal occupy the same
  // top-left visual lane. Collapse as the terminal opens so the picker never
  // covers its heading, task, or controls; Daniel can deliberately reopen it.
  useEffect(() => {
    if (selectedJobId) setCollapsed(true);
  }, [selectedJobId]);

  const decideJob = async (jobId: string, decision: "approved" | "declined") => {
    setActing(`${jobId}:${decision}`);
    try {
      await fetch("/api/work-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, action: decision === "approved" ? "approve" : "decline" }),
      });
    } finally {
      setActing("");
    }
  };

  const controlJob = async (jobId: string, action: "cancel") => {
    setActing(`${jobId}:${action}`);
    try {
      await fetch("/api/work-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, action }),
      });
    } finally {
      setActing("");
    }
  };

  if (!presence.mounted) return null;
  const summary = decisions.length
    ? `${decisions.length} need${decisions.length === 1 ? "s" : ""} you`
    : running.length
      ? `${running.length} active`
      : "thinking";
  const lead = decisions[0] ?? running[0];

  return (
    <aside
      aria-label="Active JARVIS work"
      aria-live="polite"
      className={`fixed left-3 top-[58px] z-40 max-w-[calc(100vw-24px)] origin-top-left will-change-transform transition-[opacity,transform] duration-300 ease-out md:left-5 md:top-[66px] ${
        presence.visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1.5 opacity-0"
      } ${collapsed ? "w-auto" : "w-[min(320px,calc(100vw-24px))]"}`}
    >
      <div className={`overflow-hidden border border-white/10 bg-[#050a10]/88 shadow-[0_12px_38px_rgba(0,0,0,.34)] backdrop-blur-2xl ${collapsed ? "rounded-full" : "rounded-xl"}`}>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-8 max-w-[min(280px,calc(100vw-24px))] items-center gap-2 px-3 text-left"
          aria-expanded={!collapsed}
        >
          <Dot tone={decisions.length ? "amber" : "cyan"} pulse={busy || running.length > 0} />
          <span className={`shrink-0 font-mono text-[8px] uppercase tracking-[0.2em] ${decisions.length ? "text-amber" : "text-cyan"}`}>work</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-ice/90" title={lead?.label ?? lead?.task}>
            {collapsed && lead ? lead.label ?? lead.task : summary}
          </span>
          <span className="shrink-0 font-mono text-[8px] uppercase tracking-wider text-slate">{summary}</span>
          <span className="shrink-0 text-[10px] text-slate" aria-hidden>{collapsed ? "＋" : "−"}</span>
        </button>

        {!collapsed && (
          <div className="max-h-[min(46dvh,420px)] overflow-y-auto border-t border-white/8 px-2 pb-2 scrollbar-thin">
            {busy && (
              <div className="mt-1.5 flex min-w-0 items-center gap-2 rounded-md bg-cyan/[0.035] px-2 py-1.5 text-[10px] text-cyan">
                <Dot pulse />
                <span className="min-w-0 flex-1 truncate">JARVIS · conversation turn underway</span>
                <span className="shrink-0 text-[8px] uppercase tracking-wider text-slate">still available</span>
              </div>
            )}

            {decisions.map((job) => (
              <div key={String(job._id)} className="mt-1.5 border-l border-amber/45 bg-amber/[0.04] px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Dot tone="amber" />
                  <span className="min-w-0 flex-1 truncate text-[10px] text-ice" title={job.label ?? job.task}>{job.label ?? job.task}</span>
                </div>
                {job.status === "awaiting_approval" ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-3.5">
                    <button disabled={Boolean(acting)} onClick={() => void decideJob(String(job._id), "approved")} className="rounded border border-cyan/35 bg-cyan/10 px-2 py-0.5 text-[8px] uppercase tracking-wider text-cyan disabled:opacity-40">approve scope</button>
                    <button disabled={Boolean(acting)} onClick={() => void decideJob(String(job._id), "declined")} className="rounded border border-white/10 px-2 py-0.5 text-[8px] uppercase tracking-wider text-slate disabled:opacity-40">decline</button>
                  </div>
                ) : (
                  <button onClick={() => onSelectJob(String(job._id))} className="ml-3.5 mt-1 text-[8px] uppercase tracking-wider text-cyan">open · answer in chat</button>
                )}
              </div>
            ))}

            {running.map((job) => {
              const selected = selectedJobId === String(job._id);
              return (
                <button
                  type="button"
                  key={String(job._id)}
                  onClick={() => onSelectJob(String(job._id))}
                  className={`mt-1.5 w-full min-w-0 border-l px-2 py-1.5 text-left transition-colors ${selected ? "border-cyan bg-cyan/[0.07]" : "border-white/10 hover:border-cyan/40 hover:bg-white/[0.025]"}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Dot pulse />
                    <span className="shrink-0 text-[9px] text-cyan/90">{job.agentId ? AGENT_NAMES[job.agentId] ?? "Agent" : "Agent"}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-ice" title={job.label ?? job.task}>{job.label ?? job.task}</span>
                    <span className="shrink-0 font-mono text-[8px] text-slate">{job.percent ?? 0}%</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 pl-3.5 text-[8px] text-slate">
                    <span className="min-w-0 flex-1 truncate">{job.stage ?? job.progress ?? "working"}</span>
                    <span className="shrink-0">{age(job.heartbeatAt ?? job.startedAt)}</span>
                  </div>
                  <div className="ml-3.5 mt-1 h-px overflow-hidden bg-white/7">
                    <div className="h-full bg-cyan/70 transition-[width] duration-500" style={{ width: `${Math.max(2, job.percent ?? 0)}%` }} />
                  </div>
                </button>
              );
            })}

            {selectedJobId && active.some((job) => String(job._id) === selectedJobId) && (
              <div className="mt-2 flex justify-end border-t border-white/8 pt-1.5">
                <button disabled={Boolean(acting)} className="text-[8px] uppercase tracking-wider text-red-300/80 disabled:opacity-40" onClick={() => void controlJob(selectedJobId, "cancel")}>cancel selected work</button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
