import type { GoalPlan, GoalValidation } from "../lib/goal-mode";

const JARVIS_CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const APP_FACTORY_CONVEX_URL =
  process.env.APP_FACTORY_CONVEX_URL ?? "https://successful-starling-140.eu-west-1.convex.cloud";

async function jarvisCall(kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${JARVIS_CONVEX_URL.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Jarvis ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 400)}`);
  }
  return payload.value;
}

async function appFactoryCall(kind: "query" | "mutation", path: string, args: Record<string, unknown>) {
  const response = await fetch(`${APP_FACTORY_CONVEX_URL.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") {
    throw new Error(`App Factory ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 400)}`);
  }
  return payload.value;
}

export async function startAppFactoryGoal(plan: GoalPlan, missionId: string) {
  if (!plan.factory) throw new Error("The Sol plan omitted the required App Factory build brief");
  const suffix = missionId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase();
  const baseSlug = plan.factory.slug.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "new-app";
  const slug = `${baseSlug}-${suffix}`.slice(0, 50);
  const existing: any = await appFactoryCall("query", "apps:bySlug", { slug });
  if (existing?._id) return { kind: "app-factory", id: String(existing._id), slug };
  const id = await appFactoryCall("mutation", "apps:create", {
    slug,
    name: plan.factory.name,
    oneLiner: plan.summary.slice(0, 120),
    idea: plan.factory.brief,
    origin: "daniel",
    priority: 100,
  });
  if (!id) throw new Error("App Factory did not return a live app id");
  return { kind: "app-factory", id: String(id), slug };
}

export async function requestAppFactoryRefinement(runId: string, validation: GoalValidation, wave: number) {
  const text = [
    `[JARVIS-GOAL-WAVE-${wave}] Sol validation found fixable product gaps.`,
    validation.gaps.length ? `Gaps:\n${validation.gaps.map((gap) => `- ${gap}`).join("\n")}` : "",
    validation.refinements.length
      ? `Required changes:\n${validation.refinements.map((item) => `- ${item.label}: ${item.task}`).join("\n")}`
      : "",
    "Repair these inside this generated application, re-run the Factory validation/review gates, and preserve the human ship approval.",
  ].filter(Boolean).join("\n\n").slice(0, 4000);
  await appFactoryCall("mutation", "apps:requestChanges", { id: runId, text });
  return { kind: "app-factory", id: runId };
}

export async function syncExternalGoalRuns() {
  const rows: any[] = (await jarvisCall("query", "goalMode:externalPending")) ?? [];
  let updated = 0;
  let wake = false;
  let blocked = 0;
  for (const row of rows.slice(0, 100)) {
    if (row.externalKind !== "app-factory" || !row.externalRunId) continue;
    try {
      const app: any = await appFactoryCall("query", "apps:get", { id: row.externalRunId });
      if (!app) throw new Error("App Factory run no longer exists");
      const result: any = await jarvisCall("mutation", "goalMode:updateExternal", {
        id: row.id,
        status: String(app.status ?? "unknown"),
        stage: String(app.stage ?? "unknown"),
        stageState: app.stageState ? String(app.stageState) : undefined,
        detail: app.lastError ? String(app.lastError).slice(0, 1_500) : undefined,
      });
      if (result?.updated) updated += 1;
      if (result?.wake) wake = true;
    } catch (error) {
      if (Number(row.externalPollFailures ?? 0) >= 12) {
        blocked += 1;
        continue;
      }
      const result: any = await jarvisCall("mutation", "goalMode:recordExternalPollFailure", {
        id: row.id,
        error: String(error).slice(0, 1000),
      }).catch(() => null);
      if (result?.blocked) blocked += 1;
    }
  }
  return { checked: rows.length, updated, blocked, wake };
}

export async function syncExternalGoalControls() {
  const rows: any[] = (await jarvisCall("query", "goalMode:externalControlsPending")) ?? [];
  let applied = 0;
  let blocked = 0;
  for (const row of rows.slice(0, 100)) {
    if (!row.externalRunId || !["pause", "resume", "retry"].includes(row.action)) continue;
    try {
      if (row.action === "retry") {
        await appFactoryCall("mutation", "apps:retry", { id: row.externalRunId });
      } else {
        await appFactoryCall("mutation", "apps:setPaused", {
          id: row.externalRunId,
          paused: row.action === "pause",
        });
      }
      const acknowledged = await jarvisCall("mutation", "goalMode:acknowledgeExternalControl", {
        id: row.id,
        action: row.action,
      });
      if (acknowledged) applied += 1;
    } catch (error) {
      // The durable outbox row remains set. The next coordinator run retries
      // the same idempotent pause/resume operation.
      if (Number(row.externalActionFailures ?? 0) >= 12) {
        blocked += 1;
        continue;
      }
      const result: any = await jarvisCall("mutation", "goalMode:recordExternalActionFailure", {
        id: row.id,
        action: row.action,
        error: String(error).slice(0, 1000),
      }).catch(() => null);
      if (result?.blocked) blocked += 1;
    }
  }
  return { checked: rows.length, applied, blocked };
}

export async function syncExternalGoalRevisions() {
  const rows: any[] = (await jarvisCall("query", "goalMode:externalRevisionsPending")) ?? [];
  let applied = 0;
  let blocked = 0;
  for (const row of rows.slice(0, 100)) {
    if (!row.externalRunId || !row.wave || row.validation?.verdict !== "refine") continue;
    try {
      await requestAppFactoryRefinement(
        String(row.externalRunId),
        row.validation as GoalValidation,
        Number(row.wave),
      );
      const acknowledged = await jarvisCall("mutation", "goalMode:acknowledgeExternalRevision", {
        id: row.id,
        wave: Number(row.wave),
      });
      if (acknowledged) applied += 1;
    } catch (error) {
      // App Factory deduplicates the stable wave fingerprint, so a crash after
      // its mutation but before this acknowledgement is safe to replay.
      if (Number(row.externalActionFailures ?? 0) >= 12) {
        blocked += 1;
        continue;
      }
      const result: any = await jarvisCall("mutation", "goalMode:recordExternalActionFailure", {
        id: row.id,
        action: "refine",
        error: String(error).slice(0, 1000),
      }).catch(() => null);
      if (result?.blocked) blocked += 1;
    }
  }
  return { checked: rows.length, applied, blocked };
}

export async function goalCoordinationDemand() {
  return await jarvisCall("query", "goalMode:coordinationDemand") as { needed?: boolean; reasons?: string[] };
}
