import { createHmac, timingSafeEqual } from "node:crypto";
import { queues, runs, tasks } from "@trigger.dev/sdk/v3";
import { NextResponse, type NextRequest } from "next/server";
import {
  BACKGROUND_READINESS_CONFIRMATION,
  BACKGROUND_WORKERS_RESUME_CONFIRMATION,
} from "@/lib/background-readiness-contract";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import type { backgroundReadiness } from "@/trigger/background-readiness";

export const runtime = "nodejs";

const TICKET_COOKIE = "jarvis_background_readiness";
const TICKET_TTL_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 512;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

type Ticket = {
  expiresAt: number;
  runId: string;
};

type PublicStatus = "idle" | "queued" | "running" | "ready" | "attention" | "unavailable";
type PublicWorkerStatus = "ready" | "paused" | "backlogged" | "unavailable";
type PublicReadinessDetail =
  | "chatgpt_connection"
  | "cloud_worker_proof"
  | "worker_configuration"
  | "worker_runtime"
  | "temporary_cleanup"
  | "unknown";
type QueueTarget = { type: "task" | "custom"; name: string };
type QueueObservation = { paused: boolean; queued: number };

const READINESS_QUEUE = { type: "task", name: "jarvis-background-readiness" } as const;
const AUTONOMOUS_WORKER_QUEUES = [
  { type: "task", name: "jarvis-chat-dispatcher" },
  { type: "task", name: "jarvis-agent-fleet-supervisor" },
  { type: "task", name: "jarvis-goal-coordinator" },
  { type: "task", name: "jarvis-insight-engine" },
  { type: "custom", name: "jarvis-background-agents" },
] as const satisfies readonly QueueTarget[];

function response(body: {
  ok: boolean;
  status: PublicStatus;
  detail?: PublicReadinessDetail;
  workers?: PublicWorkerStatus;
  queued?: number;
}, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

async function observeQueues(targets: readonly QueueTarget[]): Promise<QueueObservation> {
  const observations = await Promise.all(targets.map(async (target) => await queues.retrieve(target)));
  return {
    paused: observations.some((queue) => queue.paused),
    queued: Math.min(9_999, observations.reduce((sum, queue) => sum + Math.max(0, queue.queued), 0)),
  };
}

function publicWorkerStatus(observation: QueueObservation): PublicWorkerStatus {
  if (observation.paused) return "paused";
  if (observation.queued > 0) return "backlogged";
  return "ready";
}

async function workerState(): Promise<{ workers: PublicWorkerStatus; queued: number }> {
  try {
    const observation = await observeQueues(AUTONOMOUS_WORKER_QUEUES);
    return { workers: publicWorkerStatus(observation), queued: observation.queued };
  } catch {
    return { workers: "unavailable", queued: 0 };
  }
}

async function resumePausedQueues(targets: readonly QueueTarget[]): Promise<QueueObservation> {
  for (const target of targets) {
    const current = await queues.retrieve(target);
    if (current.paused) await queues.resume(target);
  }
  const observation = await observeQueues(targets);
  if (observation.paused) throw new Error("Trigger queue remained paused after an explicit resume");
  return observation;
}

function sign(encoded: string, sessionHash: string): string {
  return createHmac("sha256", sessionHash).update(encoded).digest("base64url");
}

function encodeTicket(ticket: Ticket, sessionHash: string): string {
  const encoded = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, sessionHash)}`;
}

function decodeTicket(value: string | undefined, sessionHash: string): Ticket | null {
  if (!value) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = sign(encoded, sessionHash);
  const actualBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { runId, expiresAt } = parsed as Record<string, unknown>;
    if (typeof runId !== "string" || !runId || runId.length > 256) return null;
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
    return { runId, expiresAt };
  } catch {
    return null;
  }
}

function setTicket(res: NextResponse, ticket: Ticket, sessionHash: string): NextResponse {
  res.cookies.set({
    name: TICKET_COOKIE,
    value: encodeTicket(ticket, sessionHash),
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: TICKET_TTL_SECONDS,
    path: "/api/background-readiness",
  });
  return res;
}

function clearTicket(res: NextResponse): NextResponse {
  res.cookies.set({
    name: TICKET_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/api/background-readiness",
  });
  return res;
}

type PublicRunState = { status: PublicStatus; detail?: PublicReadinessDetail };

function attentionDetail(report: Record<string, unknown>): PublicReadinessDetail {
  if (report.workspace === "unavailable" || report.blocker === "cloud_workspace_unavailable") {
    return "cloud_worker_proof";
  }
  if (
    report.controllerSession === "repair_required"
    || report.blocker === "subscription_unavailable"
    || report.blocker === "codex_preflight_failed"
    || report.blocker === "configuration_missing"
    || report.blocker === "source_rejected"
    || report.blocker === "credential_broker_unavailable"
    || report.blocker === "session_store_unavailable"
    || report.blocker === "snapshot_corrupt"
    || report.blocker === "snapshot_stale"
    || report.blocker === "writer_timeout"
    || report.blocker === "writer_fence_lost"
    || report.blocker === "rotation_uncertain"
    || report.blocker === "rotation_failed"
    || report.blocker === "refresh_token_reused"
  ) {
    return "chatgpt_connection";
  }
  if (report.blocker === "codex_binary_unavailable") return "worker_runtime";
  if (report.blocker === "worker_token_unavailable" || report.blocker === "controller_session_status_unavailable") {
    return "worker_configuration";
  }
  if (report.blocker === "consumer_cleanup_failed") return "temporary_cleanup";
  return "unknown";
}

function completedState(output: unknown): PublicRunState {
  if (!output || typeof output !== "object" || Array.isArray(output)) return { status: "unavailable" };
  const report = output as Record<string, unknown>;
  if (report.ready === true && report.controllerSession === "clear" && report.workspace === "ready") {
    return { status: "ready" };
  }
  if (report.ready === false && (
    report.controllerSession === "repair_required" || report.workspace === "unavailable"
  )) return { status: "attention", detail: attentionDetail(report) };
  return { status: "unavailable" };
}

function runState(run: unknown): PublicRunState {
  if (!run || typeof run !== "object" || Array.isArray(run)) return { status: "unavailable" };
  const record = run as Record<string, unknown>;
  switch (record.status) {
    case "PENDING_VERSION":
    case "QUEUED":
    case "DEQUEUED":
      return { status: "queued" };
    case "EXECUTING":
    case "WAITING":
    case "DELAYED":
      return { status: "running" };
    case "COMPLETED":
      return completedState(record.output);
    default:
      return { status: "unavailable" };
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const ticket = decodeTicket(req.cookies.get(TICKET_COOKIE)?.value, actor.authTokenHash);
  const workers = await workerState();
  if (!ticket) return clearTicket(response({ ok: true, status: "idle", ...workers }));

  try {
    const run = await runs.retrieve<typeof backgroundReadiness>(ticket.runId);
    return response({ ok: true, ...runState(run), ...workers });
  } catch {
    // Trigger errors can contain provider response bodies. Never surface them
    // through the owner UI; a fresh manual confirmation remains available.
    return response({ ok: false, status: "unavailable" }, 503);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return response({ ok: false, status: "unavailable" }, 413);
  const body = await req.json().catch(() => null) as { action?: unknown; confirm?: unknown } | null;
  const action = body?.action === "resume" ? "resume" : "verify";

  if (action === "resume") {
    if (body?.confirm !== BACKGROUND_WORKERS_RESUME_CONFIRMATION) {
      return response({ ok: false, status: "idle" }, 400);
    }
    const ticket = decodeTicket(req.cookies.get(TICKET_COOKIE)?.value, actor.authTokenHash);
    if (!ticket) return response({ ok: false, status: "attention" }, 409);
    try {
      const run = await runs.retrieve<typeof backgroundReadiness>(ticket.runId);
      if (runState(run).status !== "ready") return response({ ok: false, status: "attention" }, 409);
      const observation = await resumePausedQueues(AUTONOMOUS_WORKER_QUEUES);
      return response({
        ok: true,
        status: "ready",
        workers: publicWorkerStatus(observation),
        queued: observation.queued,
      });
    } catch {
      return response({ ok: false, status: "unavailable", workers: "unavailable", queued: 0 }, 503);
    }
  }

  if (body?.confirm !== BACKGROUND_READINESS_CONFIRMATION) return response({ ok: false, status: "idle" }, 400);

  try {
    // A paused readiness queue makes the existing "run check" control look
    // inert forever. Resuming this one no-work task is safe before the probe;
    // the autonomous queues remain paused until the probe reports ready and
    // the owner separately confirms their resume below.
    await resumePausedQueues([READINESS_QUEUE]);
    // This is intentionally a single manual trigger: no schedule, delay, or
    // retry is added here. The deployed task itself remains maxAttempts: 1.
    const handle = await tasks.trigger<typeof backgroundReadiness>("jarvis-background-readiness", undefined);
    return setTicket(
      response({ ok: true, status: "queued" }, 202),
      { runId: handle.id, expiresAt: Date.now() + TICKET_TTL_SECONDS * 1_000 },
      actor.authTokenHash,
    );
  } catch {
    return response({ ok: false, status: "unavailable" }, 503);
  }
}
