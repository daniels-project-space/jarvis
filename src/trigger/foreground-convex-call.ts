export const FOREGROUND_CONVEX_CALL_TIMEOUT_MS = 30_000;

type ForegroundConvexCallKind = "query" | "mutation";

type ForegroundConvexCallDependencies = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Keep a foreground queue claim from looking live forever when the Convex
 * transport loses its response. The caller's claim/finalize fences remain the
 * authority; this only bounds one transport attempt so its worker can settle
 * or let the durable reaper take over.
 */
export async function callForegroundConvex(
  convexUrl: string,
  workerToken: string,
  kind: ForegroundConvexCallKind,
  path: string,
  args: unknown,
  dependencies: ForegroundConvexCallDependencies = {},
) {
  const timeoutMs = dependencies.timeoutMs ?? FOREGROUND_CONVEX_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Foreground Convex call timeout is invalid");
  }
  const controller = new AbortController();
  const fetcher = dependencies.fetcher ?? fetch;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(`Convex ${kind} ${path} exceeded its foreground call deadline`);
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetcher(`${convexUrl}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        args: { ...((args ?? {}) as Record<string, unknown>), workerToken },
        format: "json",
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as {
      status?: string;
      value?: unknown;
      errorMessage?: string;
    } | null;
    if (!response.ok || !body || body.status === "error") {
      throw new Error(
        `Convex ${kind} ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 300)}`,
      );
    }
    return body.value;
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
