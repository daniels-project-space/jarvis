"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { viewerFetchWithTimeout } from "@/lib/viewer-request";

const CONFIRMATION = "run_background_readiness";
const MAX_STATUS_POLLS = 30;
const STATUS_POLL_MS = 2_000;

type ReadinessStatus = "idle" | "starting" | "queued" | "running" | "ready" | "attention" | "unavailable";

const LABELS: Record<ReadinessStatus, string> = {
  idle: "not run",
  starting: "starting…",
  queued: "queued…",
  running: "checking…",
  ready: "ready · no work launched",
  attention: "needs attention · no work launched",
  unavailable: "unavailable · no work launched",
};

function isReadinessStatus(value: unknown): value is Exclude<ReadinessStatus, "starting"> {
  return value === "idle" || value === "queued" || value === "running" || value === "ready" || value === "attention" || value === "unavailable";
}

export function BackgroundReadinessControl() {
  const [status, setStatus] = useState<ReadinessStatus>("idle");
  const [submitting, setSubmitting] = useState(false);
  const pollCount = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await viewerFetchWithTimeout("/api/background-readiness", { cache: "no-store" }, 10_000);
      const payload = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null;
      if (!res.ok || payload?.ok !== true || !isReadinessStatus(payload.status)) {
        setStatus("unavailable");
        return;
      }
      setStatus(payload.status);
    } catch {
      setStatus("unavailable");
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
    if (!window.confirm("Run the background readiness check? It only verifies the Codex worker session. It does not create work, open a workspace, or run a model.")) return;
    setSubmitting(true);
    setStatus("starting");
    pollCount.current = 0;
    try {
      const res = await viewerFetchWithTimeout("/api/background-readiness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: CONFIRMATION }),
      }, 10_000);
      const payload = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null;
      if (!res.ok || payload?.ok !== true || payload.status !== "queued") {
        setStatus("unavailable");
        return;
      }
      setStatus("queued");
      await refresh();
    } catch {
      setStatus("unavailable");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || status === "starting" || status === "queued" || status === "running";
  const tone = status === "ready"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : status === "attention" || status === "unavailable"
      ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
      : "border-white/10 bg-black/20 text-slate";

  return (
    <div className="flex max-w-[168px] flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="rounded-lg border border-cyan/30 px-3 py-1 text-[11px] text-cyan transition hover:bg-cyan/10 disabled:opacity-55"
      >
        {busy ? "checking…" : "run check"}
      </button>
      <span aria-live="polite" className={`rounded-lg border px-2 py-1 text-right text-[9px] ${tone}`}>
        {LABELS[status]}
      </span>
    </div>
  );
}
