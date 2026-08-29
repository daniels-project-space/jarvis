"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_PROVIDER_PROBE_CONFIRMATION } from "@/lib/cloud-provider-probe-control";
import { viewerFetchWithTimeout } from "@/lib/viewer-request";

const MAX_STATUS_POLLS = 45;
const STATUS_POLL_MS = 2_000;

type ProbeStatus = "idle" | "starting" | "queued" | "running" | "attested" | "attention" | "unavailable";

const LABELS: Record<ProbeStatus, string> = {
  idle: "not attested for this release",
  starting: "queueing verification…",
  queued: "queued…",
  running: "verifying provider…",
  attested: "attested · run readiness next",
  attention: "needs attention · no worker started",
  unavailable: "unavailable · no worker started",
};

function isProbeStatus(value: unknown): value is Exclude<ProbeStatus, "starting"> {
  return value === "idle" || value === "queued" || value === "running" || value === "attested" || value === "attention" || value === "unavailable";
}

/**
 * Explicit owner control for the deployment-bound cloud provider probe. The
 * probe is bounded and has no user-work payload; it refreshes the proof that
 * lets the current Trigger deployment admit real background work afterwards.
 */
export function CloudProviderProbeControl() {
  const [status, setStatus] = useState<ProbeStatus>("idle");
  const [submitting, setSubmitting] = useState(false);
  const pollCount = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await viewerFetchWithTimeout("/api/cloud-provider-probe", { cache: "no-store" }, 10_000);
      const payload = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null;
      if (!res.ok || payload?.ok !== true || !isProbeStatus(payload.status)) {
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
      const timer = window.setTimeout(() => setStatus("attention"), 0);
      return () => window.clearTimeout(timer);
    }
    pollCount.current += 1;
    const timer = window.setTimeout(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [refresh, status]);

  const start = async () => {
    if (submitting || status === "starting" || status === "queued" || status === "running") return;
    if (!window.confirm("Verify this cloud worker release? Jarvis will run one bounded, short-lived provider check. It will not create a user task or run a model.")) return;
    setSubmitting(true);
    setStatus("starting");
    pollCount.current = 0;
    try {
      const res = await viewerFetchWithTimeout("/api/cloud-provider-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION }),
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
  const tone = status === "attested"
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
        {busy ? "verifying…" : "verify release"}
      </button>
      <span aria-live="polite" className={`rounded-lg border px-2 py-1 text-right text-[9px] ${tone}`}>
        {LABELS[status]}
      </span>
    </div>
  );
}
