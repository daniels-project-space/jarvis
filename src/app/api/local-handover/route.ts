import type { NextRequest } from "next/server";
import { z } from "zod";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

const providerSchema = z.enum(["codex", "claude"]);
const requestSchema = z.object({ provider: providerSchema }).strict();
const statusSchema = z.object({
  provider: providerSchema,
  updatedAt: z.number().finite().nonnegative(),
});
type OwnerAccess =
  | { ok: true; credentials: { authTokenHash: string } }
  | { ok: false; response: Response };

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function safeStatus(value: unknown) {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) return null;
  const provider = parsed.data.provider;
  return {
    provider,
    targetRuntime: provider === "claude" ? "vps_claude" : "vps_codex",
    updatedAt: parsed.data.updatedAt,
  };
}

async function ownerCredentials(req: NextRequest): Promise<OwnerAccess> {
  const actor = await controlActor(req);
  if (!actor) return { ok: false, response: noStore({ ok: false }, 401) };
  if (!isOwnerActor(actor)) {
    return { ok: false, response: noStore({ ok: false, error: "owner enrollment required" }, 403) };
  }
  return { ok: true, credentials: controlCredentials(actor) };
}

export async function GET(req: NextRequest): Promise<Response> {
  const access = await ownerCredentials(req);
  if (!access.ok) return access.response;
  try {
    const status = safeStatus(await controlQuery("ui:getLocalCodingProvider", access.credentials));
    if (!status) throw new Error("invalid handover status");
    return noStore({ ok: true, status });
  } catch {
    return noStore({ ok: false, error: "handover status is temporarily unavailable" }, 503);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const access = await ownerCredentials(req);
  if (!access.ok) return access.response;
  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return noStore({ ok: false, error: "provider must be codex or claude" }, 400);
  }
  try {
    const status = safeStatus(await controlMutation("ui:setLocalCodingProvider", {
      ...access.credentials,
      provider: parsed.data.provider,
    }));
    if (!status) throw new Error("invalid handover status");
    return noStore({ ok: true, status });
  } catch {
    return noStore({ ok: false, error: "handover target could not be saved" }, 503);
  }
}
