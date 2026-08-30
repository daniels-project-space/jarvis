import {
  classifyContextProfile,
  compileContext,
  requiresHubSnapshot,
  type ContextCompilerInput,
} from "./context-compiler";
import { resolveConvexUrl } from "./convex-url";
import { PORTFOLIO_NORTH_STAR, PROJECT_REGISTRY } from "./project-registry";
import { HUB_CONTEXT_URL, hubContextRequestArgs } from "./hub-context-contract";

const CONVEX_URL = resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL, process.env.CONVEX_URL);
type BrainContext = ContextCompilerInput["brain"];
type HubContext = ContextCompilerInput["hub"];

let hubCache: { value: HubContext; expiresAt: number } | null = null;
let hubRequest: Promise<HubContext> | null = null;
let brainLastKnownGood: { value: BrainContext; capturedAt: number; queryKey: string } | null = null;
let hubLastKnownGood: { value: HubContext; capturedAt: number } | null = null;

export const CONTEXT_INPUT_DEADLINE_MS = 850;
export const CONTEXT_LAST_KNOWN_GOOD_MS = 5 * 60_000;

async function query<T = unknown>(
  base: string,
  path: string,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const workerToken = base === CONVEX_URL ? process.env.JARVIS_WORKER_TOKEN : undefined;
    const protectedArgs = workerToken
      ? { ...((args ?? {}) as Record<string, unknown>), workerToken }
      : args;
    const response = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
      signal,
    });
    if (!response.ok) return null;
    return (((await response.json()) as { value?: unknown }).value ?? null) as T | null;
  } catch {
    return null;
  }
}

async function hubSnapshot(signal?: AbortSignal): Promise<HubContext> {
  const args = hubContextRequestArgs();
  if (!args) return null;
  if (hubCache && hubCache.expiresAt > Date.now()) return hubCache.value;
  if (hubRequest) return hubRequest;
  hubRequest = query<HubContext>(HUB_CONTEXT_URL, "jarvisContext:snapshot", args, signal).then((value) => {
    hubCache = { value, expiresAt: Date.now() + (value ? 20_000 : 3_000) };
    return value;
  }).finally(() => {
    hubRequest = null;
  });
  return hubRequest;
}

export async function boundedSnapshot<T>(
  read: (signal: AbortSignal) => Promise<T>,
  getLastKnownGood: () => { value: T; capturedAt: number } | null,
  setLastKnownGood: (snapshot: { value: T; capturedAt: number }) => void,
): Promise<T | null> {
  const controller = new AbortController();
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort("context deadline");
      resolve(null);
    }, CONTEXT_INPUT_DEADLINE_MS);
  });
  const result = Promise.resolve()
    .then(() => read(controller.signal))
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

export async function buildContext(userText?: string): Promise<string> {
  if (classifyContextProfile(userText) === "reflex") {
    return compileContext({
      userText,
      northStar: PORTFOLIO_NORTH_STAR,
      brain: null,
      hub: null,
      projectRegistry: PROJECT_REGISTRY,
    });
  }
  const brainQueryText = userText?.slice(0, 240) || undefined;
  const brainQueryKey = brainQueryText ?? "";
  const [brain, hub] = await Promise.all([
    boundedSnapshot(
      (signal) => query<BrainContext>(CONVEX_URL, "brainContext:snapshot", { userText: brainQueryText }, signal),
      () => brainLastKnownGood?.queryKey === brainQueryKey ? brainLastKnownGood : null,
      (snapshot) => { brainLastKnownGood = { ...snapshot, queryKey: brainQueryKey }; },
    ),
    requiresHubSnapshot(userText)
      ? boundedSnapshot(
        (signal) => hubSnapshot(signal),
        () => hubLastKnownGood,
        (snapshot) => { hubLastKnownGood = snapshot; },
      )
      : Promise.resolve(null),
  ]);
  return compileContext({
    userText,
    northStar: PORTFOLIO_NORTH_STAR,
    brain,
    hub,
    projectRegistry: PROJECT_REGISTRY,
  });
}
