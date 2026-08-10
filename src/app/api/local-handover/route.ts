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

function noStore(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function safeStatus(value: unknown) {
  const parsed = statusSchema.safeParse(value);
  const provider = parsed.success ? parsed.data.provider : "codex";
  return {
    provider,
    targetRuntime: provider === "claude" ? "vps_claude" : "vps_codex",
    updatedAt: parsed.success ? parsed.data.updatedAt : 0,
  };
}

async function ownerCredentials(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return { response: noStore({ ok: false }, 401) };
  if (!isOwnerActor(actor)) {
    return { response: noStore({ ok: false, error: "owner enrollment required" }, 403) };
  }
  return { credentials: controlCredentials(actor) };
}

export async function GET(req: NextRequest) {
  const access = await ownerCredentials(req);
  if ("response" in access) return access.response;
  try {
    const status = await controlQuery("ui:getLocalCodingProvider", access.credentials);
    return noStore({ ok: true, status: safeStatus(status) });
  } catch {
    return noStore({ ok: false, error: "handover status is temporarily unavailable" }, 503);
  }
}

export async function POST(req: NextRequest) {
  const access = await ownerCredentials(req);
  if ("response" in access) return access.response;
  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return noStore({ ok: false, error: "provider must be codex or claude" }, 400);
  }
  try {
    const status = await controlMutation("ui:setLocalCodingProvider", {
      ...access.credentials,
      provider: parsed.data.provider,
    });
    return noStore({ ok: true, status: safeStatus(status) });
  } catch {
    return noStore({ ok: false, error: "handover target could not be saved" }, 503);
  }
}
