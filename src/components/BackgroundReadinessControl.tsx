"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKGROUND_READINESS_CONFIRMATION,
  BACKGROUND_WORKERS_RESUME_CONFIRMATION,
} from "@/lib/background-readiness-contract";
import { viewerFetchWithTimeout } from "@/lib/viewer-request";

const MAX_STATUS_POLLS = 30;
const STATUS_POLL_MS = 2_000;

type ReadinessStatus = "idle" | "starting" | "queued" | "running" | "ready" | "attention" | "unavailable";
type WorkerStatus = "ready" | "paused" | "backlogged" | "unavailable";
type ReadinessDetail = "chatgpt_connection" | "cloud_worker_proof" | "worker_configuration" | "worker_runtime" | "temporary_cleanup" | "unknown";

const LABELS: Record<ReadinessStatus, string> = {
  idle: "not run",
  starting: "starting…",
  queued: "queued…",
  running: "checking…",
  ready: "ready · no work launched",
  attention: "needs attention · no work launched",
  unavailable: "unavailable · no work launched",
};

const DETAIL_LABELS: Record<ReadinessDetail, string> = {
  chatgpt_connection: "Reconnect ChatGPT, then run again",
  cloud_worker_proof: "Verify cloud worker release first",
  worker_configuration: "Worker setup is incomplete",
  worker_runtime: "Worker runtime needs repair",
  temporary_cleanup: "Cleanup failed · run again shortly",
  unknown: "Readiness needs attention",
};

function isReadinessStatus(value: unknown): value is Exclude<ReadinessStatus, "starting"> {
  return value === "idle" || value === "queued" || value === "running" || value === "ready" || value === "attention" || value === "unavailable";
}

function isReadinessDetail(value: unknown): value is ReadinessDetail {
  return value === "chatgpt_connection"
    || value === "cloud_worker_proof"
    || value === "worker_configuration"
    || value === "worker_runtime"
    || value === "temporary_cleanup"
    || value === "unknown";
}

export function BackgroundReadinessControl() {
  const [status, setStatus] = useState<ReadinessStatus>("idle");
  const [workers, setWorkers] = useState<WorkerStatus>("unavailable");
  const [queued, setQueued] = useState(0);
  const [detail, setDetail] = useState<ReadinessDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollCount = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await viewerFetchWithTimeout("/api/background-readiness", { cache: "no-store" }, 10_000);
      const payload = await res.json().catch(() => null) as {
        ok?: unknown;
        status?: unknown;
        workers?: unknown;
        queued?: unknown;
        detail?: unknown;
      } | null;
      if (!res.ok || payload?.ok !== true || !isReadinessStatus(payload.status)) {
        setStatus("unavailable");
        setDetail(null);
        return;
      }
      setStatus(payload.status);
      setDetail(payload.status === "attention" && isReadinessDetail(payload.detail) ? payload.detail : null);
      if (payload.workers === "ready" || payload.workers === "paused" || payload.workers === "backlogged" || payload.workers === "unavailable") {
        setWorkers(payload.workers);
      }
      if (typeof payload.queued === "number" && Number.isSafeInteger(payload.queued) && payload.queued >= 0) {
        setQueued(payload.queued);
      }
    } catch {
      setStatus("unavailable");
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    if (pollCount.current >= MAX_STATUS_POLLS) {
      const timer = window.setTimeout(() => setStatus("unavailable"), 0);
      return () => window.clearTimeout(timer);
    }
    pollCount.current += 1;
    const timer = window.setTimeout(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [refresh, status]);

  const start = async () => {
    if (submitting || status === "starting" || status === "queued" || status === "running") return;
    if (!window.confirm("Run the background readiness check? It verifies the Codex session and the current workspace proof. It does not create work, open a workspace, or run a model.")) return;
    setSubmitting(true);
    setStatus("starting");
    setDetail(null);
    pollCount.current = 0;
    try {
      const res = await viewerFetchWithTimeout("/api/background-readiness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: BACKGROUND_READINESS_CONFIRMATION }),
      }, 10_000);
      const payload = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null;
      if (!res.ok || payload?.ok !== true || payload.status !== "queued") {
        setStatus("unavailable");
        setDetail(null);
        return;
      }
      setStatus("queued");
      await refresh();
    } catch {
      setStatus("unavailable");
      setDetail(null);
    } finally {
      setSubmitting(false);
    }
  };

  const resume = async () => {
    if (submitting || status !== "ready" || workers !== "paused") return;
    if (!window.confirm("The worker session and workspace proof are ready. Resume Jarvis's chat dispatcher, goal coordinator, insight engine, and autonomous worker queues?")) return;
    setSubmitting(true);
    try {
      const res = await viewerFetchWithTimeout("/api/background-readiness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", confirm: BACKGROUND_WORKERS_RESUME_CONFIRMATION }),
      }, 15_000);
      const payload = await res.json().catch(() => null) as { ok?: unknown; status?: unknown; workers?: unknown; queued?: unknown } | null;
      if (!res.ok || payload?.ok !== true || payload.status !== "ready") {
        setStatus("unavailable");
        return;
      }
      setWorkers(payload.workers === "backlogged" ? "backlogged" : "ready");
      setQueued(typeof payload.queued === "number" ? payload.queued : 0);
    } catch {
      setStatus("unavailable");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || status === "starting" || status === "queued" || status === "running";
  const canResume = status === "ready" && workers === "paused";
  const tone = status === "ready" && workers !== "paused" && workers !== "unavailable"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : status === "attention" || status === "unavailable" || workers === "paused" || workers === "unavailable"
      ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
      : "border-white/10 bg-black/20 text-slate";
  const statusLabel = status === "attention" && detail ? DETAIL_LABELS[detail] : LABELS[status];

  return (
    <div className="flex max-w-[168px] flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={() => void (canResume ? resume() : start())}
        disabled={busy}
        className="rounded-lg border border-cyan/30 px-3 py-1 text-[11px] text-cyan transition hover:bg-cyan/10 disabled:opacity-55"
      >
        {busy ? "checking…" : canResume ? "resume workers" : "run check"}
      </button>
      <span aria-live="polite" className={`rounded-lg border px-2 py-1 text-right text-[9px] ${tone}`}>
        {statusLabel}
      </span>
      <span className="text-right text-[9px] text-slate" aria-live="polite">
        {workers === "paused"
          ? "workers paused"
          : workers === "backlogged"
            ? `${queued} queued · draining`
            : workers === "ready"
              ? "workers active"
              : "worker state unavailable"}
      </span>
    </div>
  );
}
