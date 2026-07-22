import { tasks } from "@trigger.dev/sdk/v3";
import type { agentWorker } from "../trigger/agent-runner";
import { resolveConvexUrl } from "./convex-url";
import { BACKGROUND_CONCURRENCY_LIMIT } from "./work-scheduler";

const CONVEX_URL = resolveConvexUrl(process.env.CONVEX_URL, process.env.NEXT_PUBLIC_CONVEX_URL);
const DEFAULT_FAN_OUT = BACKGROUND_CONCURRENCY_LIMIT;

type Reservation = {
  jobId: string;
  dispatchId: string;
  attempt: number;
  missionId: string | null;
  missionGroupId?: string;
  projectGroupId?: string;
  projectRepository?: string | null;
  schedulingGroupKey?: string;
  agentId: string | null;
  label: string;
};

function safeTag(prefix: string, value: string): string {
  return `${prefix}:${value}`.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 64);
}

async function workerMutation<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Fleet dispatch mutation ${path} failed`);
  }
  return payload?.value as T;
}

/**
 * Reserve disjoint runnable jobs in Convex, then fan each one out as its own
 * Trigger.dev run. The reservation mutation is the concurrency authority; an
 * arbitrary number of routes and supervisors can call this safely at once.
 */
export async function wakeAgentFleet(reason: string, fanOut = DEFAULT_FAN_OUT): Promise<boolean> {
  const cleanReason = reason.trim().replace(/\s+/g, " ").slice(0, 160) || "work-available";
  const limit = Math.max(1, Math.min(BACKGROUND_CONCURRENCY_LIMIT, Math.floor(fanOut)));
  const reserved = await workerMutation<{ reservations?: Reservation[] }>("jobs:reserveDispatchBatch", {
    limit,
    reason: cleanReason,
  });
  const reservations = Array.isArray(reserved?.reservations) ? reserved.reservations : [];
  if (!reservations.length) return false;

  try {
    await tasks.batchTrigger<typeof agentWorker>(
      "jarvis-agent-worker",
      reservations.map((reservation) => ({
        payload: {
          jobId: reservation.jobId,
          dispatchId: reservation.dispatchId,
          reason: cleanReason,
        },
        options: {
          tags: [
            "jarvis-agent",
            safeTag("job", reservation.jobId),
            ...(reservation.missionId ? [safeTag("mission", reservation.missionId)] : []),
            ...(reservation.agentId ? [safeTag("agent", reservation.agentId)] : []),
          ],
          metadata: {
            jobId: reservation.jobId,
            missionId: reservation.missionId,
            missionGroupId: reservation.missionGroupId ?? null,
            projectGroupId: reservation.projectGroupId ?? null,
            projectRepository: reservation.projectRepository ?? null,
            agentId: reservation.agentId,
            label: reservation.label.slice(0, 120),
            reason: cleanReason,
            stage: "dispatching",
            percent: 1,
          },
          maxAttempts: 2,
        },
      })),
    );
    return true;
  } catch (error) {
    // A transport error can be ambiguous after a batch is accepted. Do not
    // immediately make the jobs claimable twice; shorten their reservations
    // and let the minute supervisor recover any run that truly never arrived.
    await Promise.all(
      reservations.map((reservation) =>
        workerMutation("jobs:rejectDispatch", {
          jobId: reservation.jobId,
          dispatchId: reservation.dispatchId,
          reason: `Trigger launch failed: ${String(error).slice(0, 220)}`,
          delayMs: 30_000,
        }).catch(() => false),
      ),
    );
    return false;
  }
}
