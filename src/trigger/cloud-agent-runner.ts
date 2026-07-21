import { CodexAppServer } from "./codex-app-server";
import { CloudWorkspaceToolBridge, CLOUD_REPOSITORY_TOOLS } from "./cloud-workspace-tools";
import { CloudWorkspaceError, type CloudWorkspace, type CloudWorkspaceProvider } from "./cloud-workspace";

// Codex app-server 0.144.5 accepts controller-owned dynamic tools, but its
// thread/start protocol has no setting that disables the built-in host
// shell/filesystem tools. A read-only empty cwd prevents writes; it does not
// prove that an absolute read outside that cwd is impossible. Keep the live
// worker gate closed until both this protocol gap and each real provider probe
// have independently passed. These are evidence flags, never env toggles.
export const CLOUD_AGENT_EXECUTION_READINESS = Object.freeze({
  codexAppServerBuiltInHostToolsDisabled: false,
  realProviderLifecycleProbePassed: Object.freeze({
    e2b: false,
    daytona: false,
    sandbox0: false,
    cloudflare: false,
  }),
});

export function assertCloudAgentExecutionReady(provider: CloudWorkspaceProvider): void {
  const blockers: string[] = [];
  if (!CLOUD_AGENT_EXECUTION_READINESS.codexAppServerBuiltInHostToolsDisabled) {
    blockers.push("Codex app-server built-in host tools cannot be disabled by the pinned protocol");
  }
  if (!CLOUD_AGENT_EXECUTION_READINESS.realProviderLifecycleProbePassed[provider.name]) {
    blockers.push(`${provider.name} credential/quota/lifecycle probe is unverified`);
  }
  if (blockers.length) {
    throw new CloudWorkspaceError(
      provider.name,
      "controller_isolation_unproven",
      blockers.join("; "),
      "blocked",
    );
  }
}

export type CloudAgentRun = {
  text: string;
  timedOut: boolean;
  stopped: "paused" | "cancelled" | "stalled" | "steered" | null;
  checkpointLog: string;
  commands: [];
};

export async function runCloudWorkspaceAgent(input: {
  bin: string;
  controllerScratch: string;
  controllerEnv: NodeJS.ProcessEnv;
  provider: CloudWorkspaceProvider;
  workspace: CloudWorkspace;
  prompt: string;
  model: string;
  timeoutMs: number;
  executionState?: () => Promise<string>;
  onProgress?: (line: string, log?: string, stage?: string, percent?: number) => void;
}): Promise<CloudAgentRun> {
  // Defense in depth for any future caller. The Trigger caller performs this
  // check before processJob so no checkout/archive subprocess can start.
  assertCloudAgentExecutionReady(input.provider);
  const abort = new AbortController();
  let stopped: CloudAgentRun["stopped"] = null;
  let log = "";
  const bridge = new CloudWorkspaceToolBridge(input.provider, input.workspace, {
    signal: abort.signal,
    beforeTool: async () => {
      const state = await input.executionState?.() ?? "running";
      return state === "running" ? "running" : state === "cancelled" ? "cancelled" : state === "steered" ? "steered" : "stale";
    },
  });
  const server = new CodexAppServer(input.bin, input.controllerEnv, input.timeoutMs, {
    dynamicTools: CLOUD_REPOSITORY_TOOLS,
    onDynamicToolCall: (call) => bridge.invoke(call),
    controllerCwd: input.controllerScratch,
    threadSandbox: "read-only",
    ephemeral: true,
    developerInstructions:
      "You are a background repository specialist. The controller scratch is empty and read-only. " +
      "All repository reads, writes, listings, and commands MUST use the repository_* dynamic tools. " +
      "Never use a built-in host shell or filesystem tool for repository work. The sandbox has no credentials and no network by default.",
  });
  const control = input.executionState
    ? setInterval(async () => {
        if (stopped) return;
        const state = await input.executionState!().catch(() => "unknown");
        if (["paused", "cancelled", "stalled", "steered", "superseded"].includes(state)) {
          stopped = state === "superseded" ? "cancelled" : state as CloudAgentRun["stopped"];
          abort.abort();
          server.stop();
        }
      }, 2_000)
    : undefined;
  control?.unref?.();
  const timer = setTimeout(() => { abort.abort(); server.stop(); }, input.timeoutMs);
  timer.unref?.();
  const startedAt = Date.now();
  try {
    const turn = await server.runTurn({
      conversationId: `workspace:${input.workspace.providerWorkspaceId}:${input.workspace.providerSessionId}`,
      userText: input.prompt,
      history: [],
      contextBlock: "The durable work item is authoritative; this provider session is disposable transport.",
      preamble: "Complete the scoped repository task using only the controller-owned cloud repository tools.",
      modelTier: input.model,
      onDelta: (delta) => {
        log = (log + delta).slice(-12_000);
        input.onProgress?.(delta.trim().replace(/\s+/g, " ").slice(-160) || "working", log, "executing", 60);
      },
    });
    return {
      text: turn.finalText || (turn.code === 0 ? "(no output)" : `error: ${turn.stderr}`),
      timedOut: Date.now() - startedAt >= input.timeoutMs,
      stopped,
      checkpointLog: log,
      commands: [],
    };
  } catch (error) {
    const timedOut = !stopped && Date.now() - startedAt >= input.timeoutMs;
    return {
      text: stopped ? `(agent ${stopped})` : timedOut ? "(agent segment timed out)" : `error: ${error instanceof Error ? error.message : String(error)}`,
      timedOut,
      stopped,
      checkpointLog: log,
      commands: [],
    };
  } finally {
    if (control) clearInterval(control);
    clearTimeout(timer);
    server.stop();
  }
}
