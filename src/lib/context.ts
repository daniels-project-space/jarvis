import "server-only";
import { currentAdminSession } from "./control-context";
import { compileContext } from "./context-compiler";
import { resolveConvexUrl } from "./convex-url";
import { PORTFOLIO_NORTH_STAR, PROJECT_REGISTRY } from "./project-registry";

// Server-side context bundle for the brain: memory, business intel, hub
// (to-dos/calendar/wealth), cloud stack, running agents, fresh findings.
// Used by the subscription conversation worker on every turn.

const CONVEX_URL = resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL, process.env.CONVEX_URL);
const HUB_URL = "https://fantastic-roadrunner-485.convex.cloud";
let hubCache: { value: any; expiresAt: number } | null = null;
let hubRequest: Promise<any> | null = null;
let brainLastKnownGood: { value: any; capturedAt: number } | null = null;
let hubLastKnownGood: { value: any; capturedAt: number } | null = null;

// These snapshots enrich a foreground answer; they are never allowed to hold
// the conversational lane hostage. The measured normal path is sub-second,
// so a small deadline is enough to preserve freshness without turning a
// provider stall into an indefinite model delay.
export const CONTEXT_INPUT_DEADLINE_MS = 850;
export const CONTEXT_LAST_KNOWN_GOOD_MS = 5 * 60_000;

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

async function hubSnapshot(signal?: AbortSignal) {
  if (hubCache && hubCache.expiresAt > Date.now()) return hubCache.value;
  if (hubRequest) return hubRequest;
  hubRequest = q(HUB_URL, "jarvisContext:snapshot", {
    vaultToken: process.env.VAULT_ACCESS_TOKEN,
  }, signal).then((value) => {
    // The remote-work hub is expensive relative to a conversational turn and
    // does not change token-by-token. A short shared cache removes a whole
    // network dependency from rapid follow-ups while keeping work data fresh.
    hubCache = { value, expiresAt: Date.now() + (value ? 20_000 : 3_000) };
    return value;
  }).finally(() => {
    hubRequest = null;
  });
  return hubRequest;
}

export async function boundedSnapshot(
  read: (signal: AbortSignal) => Promise<any>,
  getLastKnownGood: () => { value: any; capturedAt: number } | null,
  setLastKnownGood: (snapshot: { value: any; capturedAt: number }) => void,
): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  // The transport may be a shared Hub request owned by another caller. Race at
  // this caller boundary as well as aborting the transport we own, so joining
  // a stalled request can never extend this foreground turn past 850ms.
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort("context deadline");
      resolve(null);
    }, CONTEXT_INPUT_DEADLINE_MS);
  });
  const result = Promise.resolve()
    .then(() => read(controller.signal))
    // Keep observing a late shared rejection after this caller has returned.
    .catch(() => null);
  try {
    const value = await Promise.race([result, deadline]);
    if (!timedOut && value !== null && value !== undefined) {
      setLastKnownGood({ value, capturedAt: Date.now() });
      return value;
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  const previous = getLastKnownGood();
  return previous && Date.now() - previous.capturedAt <= CONTEXT_LAST_KNOWN_GOOD_MS
    ? previous.value
    : null;
}

// Self-healing hook: anything server-side that breaks files an incident; the
// healer (agent-runner) turns open incidents into root-cause repair agents.
export async function reportIncident(source: string, signature: string, message: string, app?: string, authTokenHash?: string) {
  try {
    await convexMutation("incidents:report", { source, signature, message, app, authTokenHash });
  } catch {
    /* never let telemetry break the caller */
  }
}

export async function buildContext(
  userText?: string,
): Promise<string> {
  const [brain, hub] = await Promise.all([
    boundedSnapshot(
      (signal) => q(CONVEX_URL, "brainContext:snapshot", { userText: userText?.slice(0, 240) || undefined }, signal),
      () => brainLastKnownGood,
      (snapshot) => { brainLastKnownGood = snapshot; },
    ),
    boundedSnapshot(
      (signal) => hubSnapshot(signal),
      () => hubLastKnownGood,
      (snapshot) => { hubLastKnownGood = snapshot; },
    ),
  ]);
  // Keep the expensive state snapshot durable and reusable, but compile only
  // the evidence needed for this exact turn. Passing the entire snapshot made
  // simple spoken replies pay for unrelated portfolio and work history.
  return compileContext({
    userText,
    northStar: PORTFOLIO_NORTH_STAR,
    brain,
    hub,
    projectRegistry: PROJECT_REGISTRY,
  });
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
