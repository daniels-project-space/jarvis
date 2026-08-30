import "server-only";
import { currentAdminSession } from "./control-context";
import { resolveConvexUrl } from "./convex-url";
export {
  boundedSnapshot,
  buildContext,
  CONTEXT_INPUT_DEADLINE_MS,
  CONTEXT_LAST_KNOWN_GOOD_MS,
} from "./foreground-context";

// Server-side context bundle for the brain: memory, business intel, hub
// (to-dos/calendar/wealth), cloud stack, running agents, fresh findings.
// Used by the subscription conversation worker on every turn.

const CONVEX_URL = resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL, process.env.CONVEX_URL);

async function q(base: string, path: string, args: unknown = {}, signal?: AbortSignal): Promise<any> {
  try {
    const authTokenHash = base === CONVEX_URL ? currentAdminSession() : null;
    const workerToken = base === CONVEX_URL ? process.env.JARVIS_WORKER_TOKEN : undefined;
    const protectedArgs = authTokenHash
      ? { ...((args ?? {}) as Record<string, unknown>), authTokenHash }
      : workerToken
        ? { ...((args ?? {}) as Record<string, unknown>), workerToken }
        : args;
    const r = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
      signal,
    });
    if (!r.ok) return null;
    return (await r.json()).value;
  } catch {
    return null;
  }
}

export async function convexMutation(path: string, args: unknown): Promise<any> {
  const authTokenHash = currentAdminSession();
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  const protectedArgs = authTokenHash
    ? { ...((args ?? {}) as Record<string, unknown>), authTokenHash }
    : workerToken
      ? { ...((args ?? {}) as Record<string, unknown>), workerToken }
      : args;
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(j.errorMessage ?? "convex mutation failed");
  return j.value;
}

export const convexQuery = (path: string, args: unknown = {}) => q(CONVEX_URL, path, args);

// Self-healing hook: anything server-side that breaks files an incident; the
// healer (agent-runner) turns open incidents into root-cause repair agents.
export async function reportIncident(source: string, signature: string, message: string, app?: string, authTokenHash?: string) {
  try {
    await convexMutation("incidents:report", { source, signature, message, app, authTokenHash });
  } catch {
    /* never let telemetry break the caller */
  }
}

// A deliberately small context retained for bounded utility callers. The rich
// snapshot remains the source for subscription conversation and durable work.
export async function buildReflexContext(): Promise<{ block: string; conversation: any[] }> {
  const brain = await q(CONVEX_URL, "reflexContext:snapshot");
  const memory = Array.isArray(brain?.memory) ? brain.memory : [];
  const panel = brain?.panel;
  const lines: string[] = [];
  if (memory.length) lines.push("Remember:\n" + memory.map((m: any) => `- ${m.title}: ${m.body}`).join("\n"));
  if (panel?.type) {
    let label = panel.title ?? panel.type;
    if (panel.type === "widget") {
      try {
        label = JSON.parse(panel.value)?.title ?? JSON.parse(panel.value)?.kind ?? label;
      } catch {
        /* keep the safe panel label */
      }
    }
    lines.push(`On screen now: ${label}. Keep it up for relevant follow-ups unless Daniel asks to replace or close it.`);
  }
  return {
    block: lines.join("\n\n").slice(0, 1_400),
    conversation: Array.isArray(brain?.conversation) ? brain.conversation : [],
  };
}
