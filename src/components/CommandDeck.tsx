"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";

type CommandDeckProps = {
  busy: boolean;
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
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function Dot({ tone = "cyan", pulse = false }: { tone?: "cyan" | "amber" | "red" | "green" | "slate"; pulse?: boolean }) {
  const colors = {
    cyan: "bg-cyan",
    amber: "bg-amber",
    red: "bg-red-400",
    green: "bg-emerald-400",
    slate: "bg-slate-500",
  };
  return (
    <span className="relative mt-[5px] flex h-1.5 w-1.5 shrink-0">
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${colors[tone]}`} />}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${colors[tone]}`} />
    </span>
  );
}

export default function CommandDeck({ busy, selectedJobId, onSelectJob }: CommandDeckProps) {
  const snapshot = useJarvisQuery(api.commandCenter.snapshot, {}) as any;
  const [collapsed, setCollapsed] = useState(false);
  const [acting, setActing] = useState("");
  useEffect(() => {
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const frame = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const active = (snapshot?.active ?? []) as any[];
  const approvals = (snapshot?.approvals ?? []) as any[];
  const attention = (snapshot?.attention ?? []) as any[];
  const agents = (snapshot?.agents ?? []) as any[];
  const projects = (snapshot?.projects ?? []) as any[];
  const recent = (snapshot?.recent ?? []) as any[];
  const needs = useMemo(
    () => [
      ...approvals.map((item) => ({ ...item, kind: "approval" })),
      ...attention
        .filter((item) => item.actionClass === "ask")
        .map((item) => ({ ...item, kind: "attention" })),
    ].slice(0, 4),
    [approvals, attention],
  );
  const unhealthy = projects.filter((project) => !/^(ready|healthy|ok|live)$/i.test(project.status));
  const workingAgents = agents.filter((agent) => agent.status === "working" || agent.status === "blocked");

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

  const controlJob = async (jobId: any, action: "pause" | "resume" | "cancel" | "retry") => {
    setActing(`${jobId}:${action}`);
    try {
      await fetch("/api/work-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: String(jobId), action }),
      });
    } finally {
      setActing("");
    }
  };

  return (
    <aside
      aria-label="JARVIS command deck"
      className={`fixed left-3 top-[58px] z-40 w-[min(360px,calc(100vw-24px))] transition-all duration-300 md:left-5 md:top-[66px] ${collapsed ? "max-w-[220px]" : ""}`}
    >
      <div className="border border-white/10 bg-[#050a10]/86 shadow-[0_18px_60px_rgba(0,0,0,.38)] backdrop-blur-2xl">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          aria-expanded={!collapsed}
        >
          <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-cyan">work now</span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-slate">
            {needs.length > 0 && <span className="text-amber">{needs.length} need you</span>}
            <span>{active.length || (busy ? 1 : 0)} active</span>
            <span aria-hidden>{collapsed ? "＋" : "−"}</span>
          </span>
        </button>

        {!collapsed && (
          <div className="max-h-[min(70dvh,680px)] overflow-y-auto border-t border-white/8 px-2.5 pb-2.5 scrollbar-thin">
            {needs.length > 0 && (
              <section className="pt-2.5">
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <h2 className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber">Needs Daniel</h2>
                  <span className="text-[9px] text-slate">only real decisions</span>
                </div>
                <div className="space-y-1">
                  {needs.map((item: any) => (
                    <div key={`${item.kind}:${item._id}`} className="border-l border-amber/45 bg-amber/[0.035] px-2 py-1.5">
                      <div className="flex gap-2">
                        <Dot tone="amber" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium text-ice">{item.summary ?? item.title}</div>
                          {item.detail && <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-slate">{item.detail}</div>}
                          {item.kind === "approval" ? (
                            <div className="mt-1.5 flex gap-1.5">
                              <button
                                type="button"
                                disabled={Boolean(acting)}
                                onClick={() => void decideJob(String(item.jobId), "approved")}
                                className="border border-cyan/35 bg-cyan/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-cyan disabled:opacity-40"
                              >
                                approve scope
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(acting)}
                                onClick={() => void decideJob(String(item.jobId), "declined")}
                                className="border border-white/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-slate disabled:opacity-40"
                              >
                                decline
                              </button>
                            </div>
                          ) : item.jobId ? (
                            <button
                              type="button"
                              onClick={() => onSelectJob(String(item.jobId))}
                              className="mt-1 text-[9px] uppercase tracking-wider text-cyan"
                            >
                              open · answer by voice/chat
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="pt-2.5">
              <div className="mb-1.5 flex items-center justify-between px-1">
                <h2 className="font-mono text-[9px] uppercase tracking-[0.18em] text-cyan">Working now</h2>
                <span className="text-[9px] text-slate">stage · evidence</span>
              </div>
              <div className="space-y-px">
                {busy && (
                  <div className="flex gap-2 px-2 py-1.5 text-[10px] text-cyan">
                    <Dot tone="cyan" pulse />
                    <span>JARVIS · acting on this conversation</span>
                  </div>
                )}
                {active.slice(0, 6).map((job) => {
                  const running = job.status === "running";
                  const selected = selectedJobId === String(job._id);
                  return (
                    <button
                      type="button"
                      key={job._id}
                      onClick={() => onSelectJob(String(job._id))}
                      className={`group w-full border-l px-2 py-1.5 text-left transition ${selected ? "border-cyan bg-cyan/[0.07]" : "border-white/10 hover:border-cyan/40 hover:bg-white/[0.025]"}`}
                    >
                      <div className="flex gap-2">
                        <Dot tone={job.status === "needs_input" || job.status === "awaiting_approval" ? "amber" : running ? "cyan" : "slate"} pulse={running} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="shrink-0 text-[10px] text-cyan/90">{AGENT_NAMES[job.agentId] ?? "Agent"}</span>
                            <span className="truncate text-[11px] text-ice">{job.label ?? job.task}</span>
                            <span className="ml-auto shrink-0 font-mono text-[9px] text-slate">{job.percent ?? 0}%</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-slate">
                            <span className="truncate">{job.stage ?? job.status}</span>
                            {(job.attempt ?? 1) > 1 && <span>· pass {job.attempt}/{job.maxAttempts ?? 12}</span>}
                            <span className="ml-auto">{age(job.heartbeatAt ?? job.startedAt)}</span>
                          </div>
                          <div className="mt-1 h-px overflow-hidden bg-white/7">
                            <div className="h-full bg-cyan/70 transition-[width] duration-500" style={{ width: `${Math.max(2, job.percent ?? 0)}%` }} />
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {!busy && active.length === 0 && (
                  <div className="flex gap-2 px-2 py-1.5 text-[10px] text-slate">
                    <Dot tone="green" />
                    <span>No queued work · team available</span>
                  </div>
                )}
              </div>
            </section>

            <section className="grid grid-cols-2 gap-px pt-2.5">
              <div className="border border-white/8 bg-white/[0.018] p-2">
                <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate">Projects</div>
                <div className="mt-1 text-[11px] text-ice">{projects.length - unhealthy.length}/{projects.length || 0} healthy</div>
                <div className={`mt-0.5 truncate text-[9px] ${unhealthy.length ? "text-amber" : "text-emerald-400"}`}>
                  {unhealthy.length ? unhealthy.slice(0, 2).map((project) => project.slug).join(" · ") : "all current"}
                </div>
              </div>
              <div className="border border-white/8 bg-white/[0.018] p-2">
                <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate">Team</div>
                <div className="mt-1 text-[11px] text-ice">{workingAgents.length} engaged · {Math.max(0, agents.length - workingAgents.length)} ready</div>
                <div className="mt-0.5 truncate text-[9px] text-cyan">
                  {workingAgents.length ? workingAgents.map((agent) => agent.name).join(" · ") : "Paul · Atlas · Iris · Maya · Sentry"}
                </div>
              </div>
            </section>

            {recent.length > 0 && (
              <section className="pt-2.5">
                <h2 className="mb-1 px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-slate">Recently done</h2>
                {recent.slice(0, 3).map((job) => (
                  <div key={job._id} className="flex gap-2 border-l border-white/8 px-2 py-1 text-[9px] text-slate">
                    <Dot tone={job.status === "done" ? "green" : "red"} />
                    <span className="min-w-0 flex-1 truncate">{AGENT_NAMES[job.agentId] ?? "Agent"} · {job.label ?? job.task}</span>
                    <span className="shrink-0">{age(job.completedAt ?? job.createdAt)}</span>
                  </div>
                ))}
              </section>
            )}

            {selectedJobId && (
              <div className="mt-2 flex justify-end gap-1.5 border-t border-white/8 pt-2">
                {active.find((job) => String(job._id) === selectedJobId)?.status === "paused" ? (
                  <button className="text-[9px] uppercase tracking-wider text-cyan" onClick={() => void controlJob(selectedJobId as any, "resume")}>resume</button>
                ) : (
                  <button className="text-[9px] uppercase tracking-wider text-slate hover:text-cyan" onClick={() => void controlJob(selectedJobId as any, "pause")}>pause</button>
                )}
                <span className="text-white/10">·</span>
                <button className="text-[9px] uppercase tracking-wider text-red-300/80" onClick={() => void controlJob(selectedJobId as any, "cancel")}>cancel</button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
