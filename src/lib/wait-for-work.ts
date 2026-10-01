export type WorkSignal = { ready: boolean; nextAt?: number | null };

/** Wait locally for a durable subscription signal, with no polling or lease. */
export function waitForWork(
  subscribe: (observe: (value: WorkSignal) => void, fail: (error: Error) => void) => () => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish();
    if (signal.aborted) return finish();
    signal.addEventListener("abort", aborted, { once: true });
    unsubscribe = subscribe(value => {
      clearTimeout(timer);
      if (value.ready) finish();
      else if (typeof value.nextAt === "number" && Number.isFinite(value.nextAt)) {
        timer = setTimeout(() => finish(), Math.min(2_147_483_647, Math.max(0, value.nextAt - Date.now())));
      }
    }, error => finish(error));
    // Some subscription adapters deliver their cached value synchronously.
    if (settled) unsubscribe();
  });
}
