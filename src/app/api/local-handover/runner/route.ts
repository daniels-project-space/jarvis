import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { LOCAL_HANDOVER_REMAINING_PERCENT, localCodingRuntime } from "@/lib/local-handover-protocol";

export const runtime = "nodejs";

const providerSchema = z.enum(["codex", "claude"]);
const runnerStatusSchema = z.object({
  version: z.string().trim().min(1).max(80),
  policyRevision: z.number().int().nonnegative(),
  managedSessions: z.number().int().nonnegative().max(10_000),
  deferredSessions: z.number().int().nonnegative().max(10_000),
  quotaState: z.enum(["available", "threshold", "unavailable"]),
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  resetsAt: z.number().int().positive().optional(),
}).strict();
const runnerRequestSchema = z.object({
  operation: z.enum(["heartbeat", "auto_failover"]),
  status: runnerStatusSchema,
  observedUsedPercent: z.number().finite().min(99).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation === "auto_failover") {
    if (value.observedUsedPercent === undefined) {
      ctx.addIssue({ code: "custom", message: "observedUsedPercent is required for auto_failover" });
    }
    if (value.status.quotaState !== "threshold" || value.status.remainingPercent === undefined || value.status.remainingPercent > 1) {
      ctx.addIssue({ code: "custom", message: "auto_failover requires a one-percent weekly threshold status" });
    }
    if (value.observedUsedPercent !== undefined && value.status.remainingPercent !== undefined
      && Math.abs((100 - value.observedUsedPercent) - value.status.remainingPercent) > 0.000_001) {
      ctx.addIssue({ code: "custom", message: "auto_failover quota evidence is inconsistent" });
    }
  }
});
const policySchema = z.object({
  provider: providerSchema,
  updatedAt: z.number().finite().nonnegative(),
  handoverRevision: z.number().int().nonnegative().optional(),
  automatic: z.object({
    codexWeeklyRemainingPercent: z.number().int().min(1).max(100),
  }).optional(),
});

type Policy = Readonly<{
  provider: "codex" | "claude";
  targetRuntime: "vps_codex" | "vps_claude";
  updatedAt: number;
  handoverRevision: number;
  automatic: { codexWeeklyRemainingPercent: number };
}>;

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.JARVIS_LOCAL_HANDOVER_RUNNER_TOKEN ?? "";
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function dispatchCredentials(): { dispatchToken: string } | null {
  const dispatchToken = process.env.JARVIS_DISPATCH_TOKEN;
  return dispatchToken ? { dispatchToken } : null;
}

function safePolicy(value: unknown): Policy | null {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    provider: parsed.data.provider,
    targetRuntime: localCodingRuntime(parsed.data.provider),
    updatedAt: parsed.data.updatedAt,
    handoverRevision: parsed.data.handoverRevision ?? 0,
    automatic: {
      codexWeeklyRemainingPercent: parsed.data.automatic?.codexWeeklyRemainingPercent
        ?? LOCAL_HANDOVER_REMAINING_PERCENT,
    },
  };
}

async function currentPolicy(credentials: { dispatchToken: string }): Promise<Policy> {
  const policy = safePolicy(await controlQuery("ui:getLocalCodingProvider", credentials));
  if (!policy) throw new Error("invalid local handover policy");
  return policy;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return noStore({ ok: false }, 401);
  const credentials = dispatchCredentials();
  if (!credentials) return noStore({ ok: false, error: "runner control is unavailable" }, 503);
  try {
    return noStore({ ok: true, policy: await currentPolicy(credentials) });
  } catch {
    return noStore({ ok: false, error: "runner policy is temporarily unavailable" }, 503);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return noStore({ ok: false }, 401);
  const credentials = dispatchCredentials();
  if (!credentials) return noStore({ ok: false, error: "runner control is unavailable" }, 503);
  const body = await req.json().catch(() => null);
  const parsed = runnerRequestSchema.safeParse(body);
  if (!parsed.success) return noStore({ ok: false, error: "invalid runner heartbeat" }, 400);

  try {
    let policy = await currentPolicy(credentials);
    // The only automatic mutation this narrow capability can request is the
    // one-way, reversible Codex-to-Claude handover after the documented weekly
    // Codex signal reaches the one-percent threshold. It cannot start jobs,
    // read work, or switch to an arbitrary provider.
    if (parsed.data.operation === "auto_failover" && policy.provider === "codex") {
      if (parsed.data.status.policyRevision !== policy.handoverRevision) {
        return noStore({ ok: false, error: "runner policy is stale" }, 409);
      }
      const changed = safePolicy(await controlMutation("ui:setLocalCodingProvider", {
        ...credentials,
        provider: "claude",
        reason: "quota",
        expectedHandoverRevision: policy.handoverRevision,
      }));
      if (!changed) throw new Error("invalid automatic handover policy");
      policy = changed;
    }
    await controlMutation("ui:recordLocalCodingRunnerStatus", {
      ...credentials,
      status: {
        ...parsed.data.status,
        policyRevision: policy.handoverRevision,
      },
    });
    return noStore({ ok: true, policy });
  } catch {
    return noStore({ ok: false, error: "runner heartbeat could not be recorded" }, 503);
  }
}
