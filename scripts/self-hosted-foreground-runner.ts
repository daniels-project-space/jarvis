import { pathToFileURL } from "node:url";
import {
  captureForegroundMemory,
  processChatQueue,
  type ForegroundQueueRuntime,
} from "../src/trigger/chat-session";
import { readSelfHostedForegroundConfig } from "../src/lib/self-hosted-foreground-config";

const RESTART_DELAY_MS = 1_500;
const SELF_HOSTED_IDLE_TIMEOUT_MS = 55 * 60 * 1_000;

function waitForRestart(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, RESTART_DELAY_MS);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function runSelfHostedForeground(): Promise<void> {
  const config = readSelfHostedForegroundConfig();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const runtime: ForegroundQueueRuntime = {
    kind: "selfhost",
    instanceId: config.instanceId,
    idleTimeoutMs: SELF_HOSTED_IDLE_TIMEOUT_MS,
    subscriptionRoot: config.stateDirectory,
    shutdownSignal: shutdown.signal,
    recordMetadata: async () => undefined,
    // The outer daemon loop replaces Trigger handoffs. A pending turn remains
    // durable in Convex and is claimed on the immediate next loop iteration.
    dispatchRunner: async () => undefined,
    captureMemory: async (payload) => {
      await captureForegroundMemory(payload, { subscriptionRoot: config.stateDirectory });
    },
  };

  try {
    while (!shutdown.signal.aborted) {
      try {
        await processChatQueue({ source: "selfhost-daemon" }, "primary", runtime);
      } catch {
        // Never print bearer material or provider responses. The durable queue
        // records startup/finalization incidents through the shared engine.
        process.stderr.write("Jarvis foreground runner cycle failed; retrying.\n");
      }
      if (!shutdown.signal.aborted) await waitForRestart(shutdown.signal);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runSelfHostedForeground().catch(() => {
    process.stderr.write("Jarvis foreground runner configuration rejected.\n");
    process.exitCode = 1;
  });
}
