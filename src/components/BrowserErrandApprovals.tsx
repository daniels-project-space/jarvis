"use client";

import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { clientMutation } from "@/lib/client-mutation";
import { useJarvisQuery } from "@/lib/secure-convex";

type PendingBrowserErrand = {
  _id: string;
  objective: string;
  plan: string[];
  executionSteps?: Array<Record<string, unknown>>;
  status: "proposed" | "needs_step_approval";
  escalation?: string;
  envelope: {
    allowedHosts: string[];
    allowedActions: string[];
    maxSends: number;
    maxSteps: number;
  };
};

type UnknownBrowserErrandOutcome = {
  _id: string;
  objective: string;
};

type DecisionState = {
  errandId: string;
  state: "working" | "done" | "error";
  detail: string;
} | null;

function actionSummary(errand: PendingBrowserErrand): string {
  const actions = errand.envelope.allowedActions.join(", ") || "none";
  const sends = Number(errand.envelope.maxSends) || 0;
  const steps = Number(errand.envelope.maxSteps) || 0;
  return `${actions} · up to ${sends} send${sends === 1 ? "" : "s"} · ${steps} steps`;
}

/**
 * Durable owner-only browser-errand approval surface.
 *
 * It deliberately queries Convex rather than recognizing a model-produced
 * marker in chat text: the model can propose an errand, but it cannot mint a
 * button or approve itself. The server route and Convex mutation each require
 * the owner's same-origin authenticated session as separate boundaries.
 */
export function BrowserErrandApprovals({ owner }: { owner: boolean }) {
  const pending = useJarvisQuery(api.browserErrands.pending, owner ? {} : "skip") as PendingBrowserErrand[] | undefined;
  const unknownOutcomes = useJarvisQuery(
    api.browserErrands.unknownOutcomes,
    owner ? {} : "skip",
  ) as UnknownBrowserErrandOutcome[] | undefined;
  const [decision, setDecision] = useState<DecisionState>(null);

  useEffect(() => {
    if (!owner) return;
    // This is terminal-only reconciliation for an abandoned request. It never
    // retries a browser action; the server records an unknown outcome instead.
    void clientMutation("browserErrands:expireStale", {}).catch(() => undefined);
  }, [owner]);

  const decide = async (errand: PendingBrowserErrand, next: "approved" | "declined") => {
    if (decision?.state === "working") return;
    setDecision({ errandId: errand._id, state: "working", detail: "saving…" });
    try {
      const accepted = await clientMutation<boolean>("browserErrands:decide", {
        errandId: errand._id,
        decision: next,
      });
      if (!accepted) throw new Error("stale decision");
      setDecision({
        errandId: errand._id,
        state: "done",
        detail: next === "approved"
          ? "Approved once. Nothing runs until you directly ask JARVIS to run these exact sealed steps."
          : "Declined. Nothing ran.",
      });
    } catch {
      setDecision({
        errandId: errand._id,
        state: "error",
        detail: "That decision was not accepted. Refresh and review the current plan.",
      });
    }
  };

  if (!owner || (!pending?.length && !unknownOutcomes?.length)) return null;

  return (
    <section
      data-browser-errand-approvals
      aria-label="Browser errand approval and recovery status"
      className="space-y-2 border-b border-amber/15 pb-3"
    >
      {unknownOutcomes?.map((errand) => (
        <article
          key={errand._id}
          data-browser-errand-recovery={errand._id}
          className="rounded-xl border border-amber/30 bg-amber/[0.055] px-3 py-2.5 text-xs text-ice"
        >
          <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-amber/85">
            browser errand outcome unknown
          </p>
          <p className="mt-0.5 font-medium text-ice">{errand.objective}</p>
          <p className="mt-2 text-[11px] text-amber/90">
            Its outcome is unknown. JARVIS did not retry it automatically.
          </p>
          <p className="mt-1 text-[11px] text-slate">
            Request a fresh exact plan if you still want to proceed.
          </p>
        </article>
      ))}

      {pending?.map((errand) => {
        const state = decision?.errandId === errand._id ? decision : null;
        const paused = errand.status === "needs_step_approval";
        const sealed = Boolean(errand.executionSteps?.length);
        return (
          <article
            key={errand._id}
            data-browser-errand-id={errand._id}
            className="rounded-xl border border-amber/30 bg-amber/[0.055] px-3 py-2.5 text-xs text-ice"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.13em] text-amber/85">
                  {paused ? "browser errand paused safely" : "browser errand needs approval"}
                </p>
                <p className="mt-0.5 font-medium text-ice">{errand.objective}</p>
              </div>
              <span className="shrink-0 rounded-full border border-amber/25 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-amber/80">
                {paused ? "paused" : "proposed"}
              </span>
            </div>

            <p className="mt-2 text-[11px] text-slate">
              Hosts: {errand.envelope.allowedHosts.join(", ") || "none"}
            </p>
            <p className="mt-0.5 text-[11px] text-slate">Allowed: {actionSummary(errand)}</p>

            {errand.plan.length > 0 && (
              <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-[11px] text-ice/85">
                {errand.plan.map((step, index) => <li key={`${errand._id}-${index}`}>{step}</li>)}
              </ol>
            )}

            {errand.executionSteps?.length ? (
              <details className="mt-2 rounded-lg border border-amber/15 bg-black/15 px-2 py-1.5 text-[10px] text-slate">
                <summary className="cursor-pointer font-mono uppercase tracking-[0.09em] text-amber/85">
                  Exact sealed executable steps ({errand.executionSteps.length})
                </summary>
                <ol className="mt-1.5 space-y-1">
                  {errand.executionSteps.map((step, index) => (
                    <li key={`${errand._id}-sealed-${index}`} className="break-all font-mono text-[10px] text-ice/80">
                      {index + 1}. {JSON.stringify(step)}
                    </li>
                  ))}
                </ol>
              </details>
            ) : (
              <p className="mt-2 text-[11px] text-amber/90">This legacy proposal has no sealed executable plan and cannot be approved to run.</p>
            )}

            {paused ? (
              <div className="mt-2 rounded-lg border border-amber/20 bg-black/15 px-2 py-1.5 text-[11px] text-amber/90">
                <p>{errand.escalation || "The browser requested a step outside the approved envelope."}</p>
                <p className="mt-1 text-slate">
                  It cannot be approved as-is. Close it, then ask JARVIS for a new exact proposal.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate">Approval permits these exact sealed steps once; it does not start the browser by itself. A separate direct request creates a one-time foreground execution receipt.</p>
            )}

            {state?.state === "done" ? (
              <p aria-live="polite" className="mt-2 text-[11px] text-cyan">{state.detail}</p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!paused && sealed && (
                  <button
                    type="button"
                    onClick={() => void decide(errand, "approved")}
                    disabled={state?.state === "working"}
                    className="rounded-lg border border-cyan/40 bg-cyan/10 px-2 py-1 text-[11px] font-medium text-cyan transition hover:bg-cyan/20 disabled:opacity-50"
                  >
                    {state?.state === "working" ? "saving…" : "Approve exact plan"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void decide(errand, "declined")}
                  disabled={state?.state === "working"}
                  className="rounded-lg border border-rose-300/30 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-50"
                >
                  {paused ? "Close paused errand" : "Decline"}
                </button>
                {state?.state === "error" && <p aria-live="polite" className="text-[11px] text-amber">{state.detail}</p>}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
