const CHUNK_RELOAD_KEY = "jarvis-chunk-reload";
const CHUNK_RELOAD_COOLDOWN_MS = 10_000;
const CLIENT_CHUNK_LOAD_ERROR = /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|\bTypeError:?\s+Load failed\b/i;

export type ClientChunkRecoveryRuntime = {
  now: () => number;
  readReloadAt: () => string | null;
  writeReloadAt: (value: string) => void;
  recordFailure: (message: string) => void;
  reload: () => void;
};

function browserRuntime(): ClientChunkRecoveryRuntime | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    now: () => Date.now(),
    readReloadAt: () => sessionStorage.getItem(CHUNK_RELOAD_KEY),
    writeReloadAt: (value) => sessionStorage.setItem(CHUNK_RELOAD_KEY, value),
    recordFailure: (message) => {
      document.documentElement.dataset.jarvisChunkFailure = message;
    },
    reload: () => window.location.reload(),
  };
}

/** Recognize the browser-specific errors emitted when a lazy module cannot be fetched. */
export function isClientChunkLoadError(value: unknown): boolean {
  try {
    const error = value as { name?: unknown; message?: unknown } | null;
    const name = typeof error?.name === "string" ? error.name : "";
    const message = typeof error?.message === "string" ? error.message : String(value ?? "");
    return CLIENT_CHUNK_LOAD_ERROR.test(`${name} ${message}`);
  } catch {
    return false;
  }
}

/** Recover a lazy client module without turning its fetch rejection into an app incident. */
export function recoverClientChunkLoad(
  error: unknown,
  providedRuntime?: ClientChunkRecoveryRuntime | null,
): void {
  const runtime = providedRuntime === undefined ? browserRuntime() : providedRuntime;
  if (!runtime) return;
  const message = String(error).replace(/\s+/g, " ").slice(0, 160);
  try {
    runtime.recordFailure(message);
  } catch {
    /* diagnostics are best effort */
  }
  try {
    const now = runtime.now();
    const last = Number(runtime.readReloadAt() || 0);
    if (now - last < CHUNK_RELOAD_COOLDOWN_MS) return;
    runtime.writeReloadAt(String(now));
  } catch {
    // Storage can be unavailable in private mode. The reload itself remains
    // best effort and is guarded whenever the browser does expose storage.
  }
  try {
    runtime.reload();
  } catch {
    /* a blocked reload must not recreate the rejected promise */
  }
}

/**
 * Dynamic imports reject when their browser chunk request fails. Resolve that
 * expected transport failure to null after scheduling stale-chunk recovery so
 * detached effects and event handlers never leak an unhandled rejection.
 */
export async function loadClientChunk<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    recoverClientChunkLoad(error);
    return null;
  }
}

/**
 * Keep a React lazy boundary in its loading state while stale-chunk recovery
 * reloads the page. Unknown module failures still reject into React's normal
 * error handling instead of being disguised as transport failures.
 */
export function recoverDynamicClientChunkLoad(
  error: unknown,
  providedRuntime?: ClientChunkRecoveryRuntime | null,
): Promise<never> {
  if (!isClientChunkLoadError(error)) return Promise.reject(error);
  recoverClientChunkLoad(error, providedRuntime);
  return new Promise<never>(() => {
    // The scheduled reload replaces this lazy boundary. If reload is blocked,
    // retaining its loading UI is safer than surfacing the handled rejection.
  });
}
