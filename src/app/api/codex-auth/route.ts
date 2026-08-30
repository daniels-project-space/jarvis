import { createHmac, timingSafeEqual } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk/v3";
import { NextResponse, type NextRequest } from "next/server";
import {
  CODEX_AUTH_ENROLLMENT_CONFIRMATION,
  CODEX_DEVICE_AUTH_URI,
} from "@/lib/codex-auth-control";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import type { codexAuthEnrollment } from "@/trigger/codex-auth-enrollment";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };
const TICKET_COOKIE = "jarvis_codex_auth_enrollment";
const TICKET_TTL_SECONDS = 20 * 60;
const MAX_BODY_BYTES = 256;
const DEVICE_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{5}$/;
const ACTIVE_ENROLLMENT_STATUSES = [
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "DELAYED",
] as const;

type Ticket = Readonly<{ expiresAt: number; runId: string }>;
type PublicState =
  | "idle"
  | "queued"
  | "starting"
  | "waiting"
  | "connected"
  | "attention"
  | "paused"
  | "unavailable";
type PublicBody = {
  ok: boolean;
  state: PublicState;
  verificationUri?: typeof CODEX_DEVICE_AUTH_URI;
  userCode?: string;
  expiresAt?: number;
};

function response(body: PublicBody, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function signature(encoded: string, key: string): string {
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

function encodeTicket(ticket: Ticket, key: string): string {
  const encoded = Buffer.from(JSON.stringify(ticket), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${signature(encoded, key)}`;
}

function decodeTicket(value: string | undefined, key: string): Ticket | null {
  if (!value) return null;
  const [encoded, supplied, extra] = value.split(".");
  if (!encoded || !supplied || extra) return null;
  const expected = signature(encoded, key);
  const suppliedBytes = Buffer.from(supplied, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const { runId, expiresAt } = parsed as Record<string, unknown>;
    return typeof runId === "string" &&
      runId.length > 0 &&
      runId.length <= 256 &&
      typeof expiresAt === "number" &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > Date.now()
      ? { runId, expiresAt }
      : null;
  } catch {
    return null;
  }
}

function setTicket(
  res: NextResponse,
  ticket: Ticket,
  key: string,
): NextResponse {
  res.cookies.set({
    name: TICKET_COOKIE,
    value: encodeTicket(ticket, key),
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: TICKET_TTL_SECONDS,
    path: "/api/codex-auth",
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
    path: "/api/codex-auth",
  });
  return res;
}

function finiteRunStatus(run: unknown): PublicBody {
  if (!run || typeof run !== "object" || Array.isArray(run))
    return { ok: false, state: "unavailable" };
  const record = run as Record<string, unknown>;
  if (
    ["PENDING_VERSION", "QUEUED", "DEQUEUED"].includes(String(record.status))
  ) {
    return { ok: true, state: "queued" };
  }
  if (["EXECUTING", "WAITING", "DELAYED"].includes(String(record.status))) {
    const metadataRecord = record.metadata;
    const enrollment =
      metadataRecord &&
      typeof metadataRecord === "object" &&
      !Array.isArray(metadataRecord)
        ? (metadataRecord as Record<string, unknown>).authEnrollment
        : null;
    if (
      enrollment &&
      typeof enrollment === "object" &&
      !Array.isArray(enrollment)
    ) {
      const safe = enrollment as Record<string, unknown>;
      if (
        safe.status === "waiting" &&
        safe.verificationUri === CODEX_DEVICE_AUTH_URI &&
        typeof safe.userCode === "string" &&
        DEVICE_CODE.test(safe.userCode) &&
        typeof safe.expiresAt === "number" &&
        Number.isSafeInteger(safe.expiresAt) &&
        safe.expiresAt > Date.now() &&
        safe.expiresAt <= Date.now() + 16 * 60_000
      ) {
        return {
          ok: true,
          state: "waiting",
          verificationUri: CODEX_DEVICE_AUTH_URI,
          userCode: safe.userCode,
          expiresAt: safe.expiresAt,
        };
      }
    }
    return { ok: true, state: "starting" };
  }
  if (record.status === "COMPLETED") {
    const output = record.output;
    return output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      (output as Record<string, unknown>).status === "connected"
      ? { ok: true, state: "connected" }
      : { ok: false, state: "attention" };
  }
  return { ok: false, state: "attention" };
}

async function owner(req: NextRequest) {
  if (!isSameOriginRequest(req)) return null;
  const actor = await controlActor(req);
  return actor && isOwnerActor(actor) ? actor : null;
}

async function cancelActiveEnrollments(): Promise<void> {
  let inspected = 0;
  for await (const run of runs.list({
    taskIdentifier: "jarvis-codex-auth-enrollment",
    status: [...ACTIVE_ENROLLMENT_STATUSES],
    from: Date.now() - TICKET_TTL_SECONDS * 1_000,
    limit: 10,
  })) {
    await runs.cancel(run.id);
    inspected += 1;
    if (inspected >= 10) break;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const actor = await owner(req);
  if (!actor) return response({ ok: false, state: "unavailable" }, 403);
  if (process.env.JARVIS_FOREGROUND_HOLD_REASON === "trigger_billing_limit") {
    return clearTicket(response({ ok: false, state: "paused" }, 503));
  }
  const ticket = decodeTicket(
    req.cookies.get(TICKET_COOKIE)?.value,
    actor.authTokenHash,
  );
  if (!ticket) return clearTicket(response({ ok: true, state: "idle" }));
  try {
    const run = await runs.retrieve<typeof codexAuthEnrollment>(ticket.runId);
    return response(finiteRunStatus(run));
  } catch {
    return response({ ok: false, state: "unavailable" }, 503);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const actor = await owner(req);
  if (!actor) return response({ ok: false, state: "unavailable" }, 403);
  if (process.env.JARVIS_FOREGROUND_HOLD_REASON === "trigger_billing_limit") {
    return response({ ok: false, state: "paused" }, 503);
  }
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES)
    return response({ ok: false, state: "unavailable" }, 413);
  const body = (await req.json().catch(() => null)) as {
    confirm?: unknown;
  } | null;
  if (body?.confirm !== CODEX_AUTH_ENROLLMENT_CONFIRMATION) {
    return response({ ok: false, state: "unavailable" }, 400);
  }
  try {
    // There is intentionally one enrollment slot. Retrying must replace an
    // abandoned run instead of silently queuing behind it for sixteen minutes.
    await cancelActiveEnrollments();
    const handle = await tasks.trigger<typeof codexAuthEnrollment>(
      "jarvis-codex-auth-enrollment",
      undefined,
    );
    return setTicket(
      response({ ok: true, state: "queued" }, 202),
      { runId: handle.id, expiresAt: Date.now() + TICKET_TTL_SECONDS * 1_000 },
      actor.authTokenHash,
    );
  } catch {
    return response({ ok: false, state: "unavailable" }, 503);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const actor = await owner(req);
  if (!actor) return response({ ok: false, state: "unavailable" }, 403);
  try {
    await cancelActiveEnrollments();
    return clearTicket(response({ ok: true, state: "idle" }));
  } catch {
    return response({ ok: false, state: "unavailable" }, 503);
  }
}
