import { createHmac, timingSafeEqual } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk/v3";
import { NextResponse, type NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import type { backgroundReadiness } from "@/trigger/background-readiness";

export const runtime = "nodejs";

export const BACKGROUND_READINESS_CONFIRMATION = "run_background_readiness";

const TICKET_COOKIE = "jarvis_background_readiness";
const TICKET_TTL_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 512;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

type Ticket = {
  expiresAt: number;
  runId: string;
};

type PublicStatus = "idle" | "queued" | "running" | "ready" | "attention" | "unavailable";

function response(body: { ok: boolean; status: PublicStatus }, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
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

function completedStatus(output: unknown): PublicStatus {
  if (!output || typeof output !== "object" || Array.isArray(output)) return "unavailable";
  const report = output as Record<string, unknown>;
  if (report.ready === true && report.controllerSession === "clear") return "ready";
  if (report.ready === false && report.controllerSession === "repair_required") return "attention";
  return "unavailable";
}

function runStatus(run: unknown): PublicStatus {
  if (!run || typeof run !== "object" || Array.isArray(run)) return "unavailable";
  const record = run as Record<string, unknown>;
  switch (record.status) {
    case "PENDING_VERSION":
    case "QUEUED":
    case "DEQUEUED":
      return "queued";
    case "EXECUTING":
    case "WAITING":
    case "DELAYED":
      return "running";
    case "COMPLETED":
      return completedStatus(record.output);
    default:
      return "unavailable";
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const ticket = decodeTicket(req.cookies.get(TICKET_COOKIE)?.value, actor.authTokenHash);
  if (!ticket) return clearTicket(response({ ok: true, status: "idle" }));

  try {
    const run = await runs.retrieve<typeof backgroundReadiness>(ticket.runId);
    return response({ ok: true, status: runStatus(run) });
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
  const body = await req.json().catch(() => null) as { confirm?: unknown } | null;
  if (body?.confirm !== BACKGROUND_READINESS_CONFIRMATION) return response({ ok: false, status: "idle" }, 400);

  try {
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
