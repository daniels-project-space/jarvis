import type { NextRequest } from "next/server";
import { z } from "zod";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { wakeAgentFleet } from "@/lib/agent-fleet-dispatch";
import { dispatchMissionSupervisorWakeTicket } from "@/lib/mission-supervisor-dispatch-server";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

const ACTIONS = new Set(["approve", "decline", "pause", "resume", "cancel", "retry", "answer", "steer"]);
const MISSION_ACTIONS = new Set(["pause", "resume", "cancel", "steer"]);

const supervisorActionSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "steer",
  "provide_input",
]);
const supervisorStateSchema = z.enum([
  "ready",
  "leased",
  "waiting",
  "paused",
  "needs_input",
  "terminal",
]);
const safeIntegerSchema = z.number().int().nonnegative().safe();
const positiveIntegerSchema = z.number().int().positive().safe();
const supervisorRequestSchema = z.object({
  protocol: z.literal("supervisor_v1"),
  missionId: z.string().min(1).max(160).regex(/^\S+$/),
  action: supervisorActionSchema,
  requestKey: z.string().regex(/^ui:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  expectedInputRevision: safeIntegerSchema,
  input: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((request, ctx) => {
  const acceptsInput = request.action === "steer"
    || request.action === "provide_input";
  if (acceptsInput && request.input === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["input"],
      message: "This supervisor action requires input.",
    });
  }
  if (!acceptsInput && request.input !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["input"],
      message: "This supervisor action does not accept input.",
    });
  }
});

const supervisorWakeTicketSchema = z.object({
  protocolVersion: z.literal(1),
  missionId: z.string().min(1).max(160),
  expectedLeaseVersion: safeIntegerSchema,
  expectedEpoch: positiveIntegerSchema,
  expectedDecisionSequence: positiveIntegerSchema,
  expectedInputRevision: safeIntegerSchema,
}).strict();

const supervisorResultSchema = z.object({
  applied: z.boolean(),
  replayed: z.boolean(),
  noop: z.boolean(),
  reason: z.string(),
  state: supervisorStateSchema.optional(),
  inputRevision: safeIntegerSchema.optional(),
  wakeTicket: supervisorWakeTicketSchema.nullable(),
});

type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;

function hasProtocol(body: unknown): body is Record<string, unknown> {
  return typeof body === "object"
    && body !== null
    && Object.prototype.hasOwnProperty.call(body, "protocol");
}

function retryableSupervisorResponse(
  error = "The supervisor control outcome is not confirmed. Retry the same request.",
) {
  return Response.json(
    { ok: false, retryable: true, error },
    { status: 503 },
  );
}

async function applySupervisorControl(
  request: SupervisorRequest,
  credentials: { authTokenHash: string },
) {
  let rawResult: unknown;
  try {
    rawResult = await controlMutation("missionSupervisor:controlV1", {
      missionId: request.missionId,
      requestKey: request.requestKey,
      action: request.action,
      expectedInputRevision: request.expectedInputRevision,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...credentials,
    });
  } catch {
    // Convex may have committed the immutable receipt before a transport
    // failure. A 503 tells the browser to replay this exact request key.
    return retryableSupervisorResponse();
  }

  const parsedResult = supervisorResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    return retryableSupervisorResponse(
      "The supervisor returned an incomplete control receipt. Retry the same request.",
    );
  }
  const result = parsedResult.data;
  if (
    result.wakeTicket !== null
    && result.wakeTicket.missionId !== request.missionId
  ) {
    return retryableSupervisorResponse(
      "The supervisor returned a wake ticket for another mission. Retry the same request.",
    );
  }
  const ok = result.applied || result.noop;
  if (!ok) {
    if (result.reason === "stale_input_revision") {
      return Response.json({
        ok: false,
        error: "Jarvis changed this mission after the controls loaded. Review the latest state and try again.",
        reason: result.reason,
        ...(result.state === undefined ? {} : { state: result.state }),
        ...(result.inputRevision === undefined
          ? {}
          : { latestRevision: result.inputRevision }),
      }, { status: 409 });
    }
    return Response.json({
      ok: false,
      error: "That supervised mission cannot apply this control from its current state.",
      reason: result.reason,
      ...(result.state === undefined ? {} : { state: result.state }),
      ...(result.inputRevision === undefined
        ? {}
        : { inputRevision: result.inputRevision }),
    }, { status: 409 });
  }

  let dispatched = false;
  let runId: string | undefined;
  if (result.wakeTicket !== null) {
    try {
      const dispatch = await dispatchMissionSupervisorWakeTicket(
        result.wakeTicket,
      );
      dispatched = dispatch.dispatched;
      if (dispatch.dispatched) runId = dispatch.runId;
    } catch {
      // The control receipt is already durable. Returning 503 preserves its
      // browser key so a replay dispatches the same exact wake ticket.
      return retryableSupervisorResponse(
        "The control was recorded, but its supervisor wake is not yet confirmed. Retry the same request.",
      );
    }
  }

  return Response.json({
    ok: true,
    replayed: result.replayed,
    noop: result.noop,
    state: result.state,
    inputRevision: result.inputRevision,
    dispatched,
    ...(runId === undefined ? {} : { runId }),
  });
}

async function applyLegacyControl(
  body: Record<string, unknown>,
  credentials: { authTokenHash: string },
) {
  const jobId = String(body.jobId ?? "");
  const missionId = String(body.missionId ?? "");
  const action = String(body.action ?? "");
  if ((!jobId && !missionId) || !ACTIONS.has(action)) {
    return Response.json({ ok: false }, { status: 400 });
  }

  let ok: unknown = false;
  let shouldWake = false;
  if (missionId) {
    if (!MISSION_ACTIONS.has(action)) {
      return Response.json({ ok: false }, { status: 400 });
    }
    const input = action === "steer"
      ? String(body.input ?? "").trim()
      : undefined;
    if (action === "steer" && !input) {
      return Response.json({ ok: false }, { status: 400 });
    }
    ok = await controlMutation("goalMode:control", {
      id: missionId,
      action,
      input,
      ...credentials,
    });
  } else if (action === "approve" || action === "decline") {
    ok = await controlMutation("approvals:decide", {
      jobId,
      decision: action === "approve" ? "approved" : "declined",
      ...credentials,
    });
  } else if (action === "answer") {
    const answer = String(body.input ?? "").trim();
    if (!answer) return Response.json({ ok: false }, { status: 400 });
    ok = await controlMutation("jobs:provideInput", {
      jobId,
      answer,
      ...credentials,
    });
  } else {
    const input = action === "steer"
      ? String(body.input ?? "").trim()
      : undefined;
    if (action === "steer" && !input) {
      return Response.json({ ok: false }, { status: 400 });
    }
    ok = await controlMutation("jobs:control", {
      jobId,
      action,
      input,
      ...credentials,
    });
  }
  if (ok === true && missionId) {
    const {
      goalCoordinationDemand,
      syncExternalGoalControls,
      syncExternalGoalRevisions,
    } = await import("@/trigger/goal-runtime");
    await syncExternalGoalControls().catch(() => null);
    await syncExternalGoalRevisions().catch(() => null);
    if (action === "resume" || action === "steer") {
      shouldWake = true;
      const demand = await goalCoordinationDemand().catch(() => null);
      if (demand) shouldWake = demand.needed === true;
    }
  } else if (
    ok === true
    && ["approve", "resume", "retry", "answer", "steer"].includes(action)
  ) {
    shouldWake = true;
  }
  if (shouldWake) {
    await wakeAgentFleet(
      `${missionId ? "goal" : "job"}-${action}:${missionId || jobId}`,
    ).catch(() => false);
  }
  // A successful exact-job control returns the bounded supervision contract,
  // never the compatibility list or durable job payload.
  const monitoring = ok === true && jobId
    ? await controlQuery("jobs:monitor", {
      jobId,
      ...credentials,
    }).catch(() => null)
    : null;
  return Response.json(
    {
      ok: ok === true,
      ...(monitoring ? { monitoring } : {}),
      ...(ok === true
        ? {}
        : {
          error:
            "That work item cannot apply this control from its current state.",
        }),
    },
    { status: ok === true ? 200 : 409 },
  );
}

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  if (!isOwnerActor(actor)) {
    return Response.json(
      { ok: false, error: "owner enrollment required" },
      { status: 403 },
    );
  }
  const credentials = controlCredentials(actor);
  const body: unknown = await req.json().catch(() => null);
  if (hasProtocol(body)) {
    const parsedRequest = supervisorRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      return Response.json(
        { ok: false, error: "Invalid supervisor control request." },
        { status: 400 },
      );
    }
    return await applySupervisorControl(parsedRequest.data, credentials);
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ ok: false }, { status: 400 });
  }
  return await applyLegacyControl(
    body as Record<string, unknown>,
    credentials,
  );
}
