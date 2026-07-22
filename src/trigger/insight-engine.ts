import { schedules } from "@trigger.dev/sdk/v3";
import { sendPush } from "./push-send";
import { wakeAgentFleet } from "../lib/agent-fleet-dispatch";

// Evidence-first proactive supervision. Trigger owns only bounded state
// reconciliation; all diagnosis and implementation remains in isolated,
// subscription-authenticated Codex CLI leases.

const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function m(path: string, args: Record<string, unknown> = {}) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") throw new Error(payload?.errorMessage ?? `${path} failed`);
  return payload?.value;
}

async function q(path: string, args: Record<string, unknown> = {}) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const payload = await response.json().catch(() => null);
  return payload?.value;
}

async function chatThread(): Promise<string> {
  const thread = await q("ui:getActiveThread").catch(() => null);
  return typeof thread === "string" && thread ? thread : "main";
}

type RecoverySweep = {
  requeued?: unknown;
  releasedDispatches?: unknown;
  expiredControllers?: unknown;
};

function recoveredCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

// The insight sweep is deliberately a second, independent recovery owner for
// the fleet supervisor. A proactive snapshot is useful enrichment, but an
// outage there must not strand a reservation, worker, or integration receipt
// that the durable reaper just made runnable.
export function shouldWakeFleetAfterInsightSweep(input: {
  eligiblePending?: unknown;
  reaped?: RecoverySweep | null;
  stuckRequeued?: unknown;
}) {
  return Number(input.eligiblePending ?? 0) > 0
    || recoveredCount(input.reaped?.requeued) > 0
    || recoveredCount(input.reaped?.releasedDispatches) > 0
    || recoveredCount(input.reaped?.expiredControllers) > 0
    || Number(input.stuckRequeued ?? 0) > 0;
}

export async function runInsightSweep() {
  // Recovery must not depend on the worker that may itself have disappeared.
  const [reaped, stuck] = await Promise.all([
    m("jobs:reapStale").catch(() => ({ requeued: [], abandoned: [] })),
    m("chatQueue:reapStuck").catch(() => ({ requeued: 0 })),
  ]);
  // Proactive triage is intentionally non-authoritative. If it is down,
  // preserve its error boundary and still wake after a causal recovery.
  const state = await m("proactive:reconcile", { now: Date.now() })
    .catch(() => ({ eligiblePending: 0, newInterruptions: [] }));
  const shouldWake = shouldWakeFleetAfterInsightSweep({
    eligiblePending: state?.eligiblePending,
    reaped,
    stuckRequeued: stuck?.requeued,
  });
  if (shouldWake) await wakeAgentFleet("proactive-reconcile").catch(() => false);

  for (const title of Array.isArray(state?.newInterruptions) ? state.newInterruptions.slice(0, 1) : []) {
    await m("chatQueue:postAssistant", {
      threadId: await chatThread(),
      text: `This genuinely needs you: ${String(title).slice(0, 180)}. I have preserved the queued work and its checkpoints.`,
    }).catch(() => null);
    await sendPush("JARVIS needs you", String(title).slice(0, 140), "/").catch(() => {});
  }

  return {
    signals: state?.signals ?? 0,
    woken: shouldWake,
    recovered: reaped?.requeued?.length ?? 0,
    abandoned: reaped?.abandoned?.length ?? 0,
    stalled: reaped?.stalled?.length ?? 0,
  };
}

export const insightEngine = schedules.task({
  id: "jarvis-insight-engine",
  cron: "*/10 * * * *",
  maxDuration: 60,
  run: runInsightSweep,
});
