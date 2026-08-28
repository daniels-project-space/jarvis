import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { sendPush } from "./push-send";
import { wakeAgentFleet } from "../lib/agent-fleet-dispatch";
import { isFileIngestWakePaused } from "../lib/file-ingest-wake";

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
  if (!response.ok || payload?.status === "error") throw new Error(payload?.errorMessage ?? `${path} failed`);
  return payload?.value;
}

async function chatThread(): Promise<string> {
  const thread = await q("ui:getActiveThread").catch(() => null);
  return typeof thread === "string" && thread ? thread : "main";
}

export const insightEngine = schedules.task({
  id: "jarvis-insight-engine",
  cron: "0 */2 * * *",
  maxDuration: 60,
  run: async () => {
    // During the V1-to-V2 cutover the Vercel bridge owns admission. Do not
    // let this independent recovery schedule a task behind that gate.
    const fileIngestWakePaused = isFileIngestWakePaused();
    // Recovery must not depend on the worker that may itself have disappeared.
    const [reaped, stuck] = await Promise.all([
      m("jobs:reapStale").catch(() => ({ requeued: [], abandoned: [] })),
      m("chatQueue:reapStuck").catch(() => ({ requeued: 0 })),
    ]);
    const [state, pendingFiles, expiredUploads, pendingDerivedCleanup, pendingOutputCleanup] = await Promise.all([
      m("proactive:reconcile", { now: Date.now() }),
      fileIngestWakePaused ? Promise.resolve([]) : q("files:pendingIngest", { limit: 4 }).catch(() => []),
      m("files:cleanupExpiredReservations", { limit: 2 }).catch(() => []),
      q("files:pendingIngestDerivedCleanup", { limit: 4 }).catch(() => []),
      q("files:pendingIngestOutputCleanup", { limit: 4 }).catch(() => []),
    ]);
    const recoveryWindow = Math.floor(Date.now() / (2 * 60 * 60_000));
    const ingestRecoveries = [];
    for (const file of Array.isArray(pendingFiles) ? pendingFiles.slice(0, 4) : []) {
      const fileId = String(file?.fileId ?? "");
      const ingestVersion = Number(file?.ingestVersion);
      if (!fileId || !Number.isSafeInteger(ingestVersion)) continue;
      ingestRecoveries.push(await tasks.trigger(
        "jarvis-file-ingest",
        { fileId, ingestVersion },
        { idempotencyKey: `jarvis-file-ingest-reconcile-${fileId}-${ingestVersion}-${recoveryWindow}` },
      ).catch(() => null));
    }
    const cleanupRecoveries = [];
    const cleanup = (Array.isArray(expiredUploads) ? expiredUploads : [])
      .flatMap((batch) => Array.isArray(batch?.cleanup) ? batch.cleanup : [])
      .slice(0, 4);
    for (const item of cleanup) {
      const fileId = String(item?.fileId ?? "");
      if (!fileId) continue;
      cleanupRecoveries.push(await tasks.trigger(
        "jarvis-file-cleanup",
        { fileId },
        { idempotencyKey: `jarvis-file-cleanup-reconcile-${fileId}-${recoveryWindow}` },
      ).catch(() => null));
    }
    const derivedCleanupRecoveries = [];
    for (const item of Array.isArray(pendingDerivedCleanup) ? pendingDerivedCleanup.slice(0, 4) : []) {
      const outboxId = String(item?.outboxId ?? "");
      if (!outboxId) continue;
      derivedCleanupRecoveries.push(await tasks.trigger(
        "jarvis-file-ingest-derived-cleanup",
        { outboxId },
        { idempotencyKey: `jarvis-file-ingest-derived-cleanup-reconcile-${outboxId}-${recoveryWindow}` },
      ).catch(() => null));
    }
    for (const item of Array.isArray(pendingOutputCleanup) ? pendingOutputCleanup.slice(0, 4) : []) {
      const outputAttemptId = String(item?.outputAttemptId ?? "");
      if (!outputAttemptId) continue;
      derivedCleanupRecoveries.push(await tasks.trigger(
        "jarvis-file-ingest-derived-cleanup",
        { outputAttemptId },
        { idempotencyKey: `jarvis-file-ingest-output-cleanup-reconcile-${outputAttemptId}-${recoveryWindow}` },
      ).catch(() => null));
    }
    const shouldWake =
      Number(state?.eligiblePending ?? 0) > 0 ||
      (Array.isArray(reaped?.requeued) && reaped.requeued.length > 0) ||
      Number(stuck?.requeued ?? 0) > 0;
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
      fileIngestRecoveries: ingestRecoveries.filter(Boolean).length,
      fileIngestWakePaused,
      fileCleanupRecoveries: cleanupRecoveries.filter(Boolean).length,
      fileDerivedCleanupRecoveries: derivedCleanupRecoveries.filter(Boolean).length,
    };
  },
});
