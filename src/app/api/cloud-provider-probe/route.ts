import { createHmac, timingSafeEqual } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk/v3";
import { NextResponse, type NextRequest } from "next/server";
import { CLOUD_PROVIDER_PROBE_CONFIRMATION } from "@/lib/cloud-provider-probe-control";
import { configuredCloudWorkspaceProviderName } from "@/lib/cloud-provider-selection";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import type { cloudProviderProbeBootstrap } from "@/trigger/cloud-provider-probe-bootstrap";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 256;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };
const TICKET_COOKIE = "jarvis_cloud_provider_probe";
const TICKET_TTL_SECONDS = 20 * 60;

type Ticket = Readonly<{ expiresAt: number; runId: string }>;
type PublicStatus = "idle" | "queued" | "running" | "attested" | "attention" | "unavailable";
type PublicDetail = "configuration" | "provider" | "publication" | "unknown";
type PublicProvider = "vercel" | "sandbox0" | "e2b" | "cloudflare" | "unconfigured";

function response(body: { ok: boolean; status: PublicStatus; detail?: PublicDetail; provider?: PublicProvider }, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function currentProvider(): PublicProvider {
  return configuredCloudWorkspaceProviderName(process.env) ?? "unconfigured";
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
    path: "/api/cloud-provider-probe",
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
    path: "/api/cloud-provider-probe",
  });
  return res;
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
    case "COMPLETED": {
      const output = record.output;
      return output && typeof output === "object" && !Array.isArray(output)
        && (output as Record<string, unknown>).status === "attested"
        ? "attested"
        : "attention";
    }
    default:
      return "attention";
  }
}

/**
 * The provider may include credential-shaped text in a failed task error.
 * Return only one stable owner-facing category, never the original message.
 */
function runFailureDetail(run: unknown): PublicDetail | undefined {
  if (!run || typeof run !== "object" || Array.isArray(run)) return undefined;
  const record = run as Record<string, unknown>;
  if (record.status === "COMPLETED" || !record.error || typeof record.error !== "object" || Array.isArray(record.error)) {
    return undefined;
  }
  const message = String((record.error as Record<string, unknown>).message ?? "").toLowerCase();
  if (/opt-in|capability|credential|provenance|template|keyring|configuration|environment|spend[ _-]?approved|plan authorization|plan (?:observation|response)|sandbox usage|billing/.test(message)) return "configuration";
  if (/publish|proof|receipt|deployment identity|attestation/.test(message)) return "publication";
  return message ? "provider" : "unknown";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const ticket = decodeTicket(req.cookies.get(TICKET_COOKIE)?.value, actor.authTokenHash);
  if (!ticket) return clearTicket(response({ ok: true, status: "idle" }));
  try {
    const run = await runs.retrieve<typeof cloudProviderProbeBootstrap>(ticket.runId);
    const status = runStatus(run);
    const detail = status === "attention" ? runFailureDetail(run) : undefined;
    return response({ ok: true, status, ...(detail ? { detail } : {}), ...(status === "attention" ? { provider: currentProvider() } : {}) });
  } catch {
    // Provider/task errors can include sensitive details. The UI receives only
    // a finite status and can safely offer a fresh owner confirmation.
    return response({ ok: false, status: "unavailable" }, 503);
  }
}

/**
 * Starts exactly one owner-approved, deployment-bound provider attestation.
 * It deliberately has neither a caller-supplied task name nor a task payload.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(req)) return response({ ok: false, status: "unavailable" }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, status: "unavailable" }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, status: "unavailable" }, 403);

  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return response({ ok: false, status: "unavailable" }, 413);
  const body = await req.json().catch(() => null) as { confirm?: unknown } | null;
  if (body?.confirm !== CLOUD_PROVIDER_PROBE_CONFIRMATION) {
    return response({ ok: false, status: "unavailable" }, 400);
  }

  try {
    const handle = await tasks.trigger<typeof cloudProviderProbeBootstrap>("jarvis-cloud-provider-probe-bootstrap", undefined);
    return setTicket(
      response({ ok: true, status: "queued" }, 202),
      { runId: handle.id, expiresAt: Date.now() + TICKET_TTL_SECONDS * 1_000 },
      actor.authTokenHash,
    );
  } catch {
    return response({ ok: false, status: "unavailable" }, 503);
  }
}
