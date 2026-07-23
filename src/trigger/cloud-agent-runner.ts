import { dirname } from "node:path";
import { readdirSync } from "node:fs";
import { CodexAppServer, CodexPermissionAttestationError } from "./codex-app-server";
import { buildCloudCodexPermissionProfile } from "./cloud-codex-permissions";
import { CloudWorkspaceToolBridge, CLOUD_REPOSITORY_TOOLS } from "./cloud-workspace-tools";
import { CloudWorkspaceError, type CloudWorkspace, type CloudWorkspaceProvider } from "./cloud-workspace";

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
  reasoningEffort: string;
  timeoutMs: number;
  executionState?: () => Promise<string>;
  onProgress?: (line: string, log?: string, stage?: string, percent?: number) => void;
}): Promise<CloudAgentRun> {
  const codexHome = String(input.controllerEnv.CODEX_HOME ?? "");
  let permissionProfile;
  try {
    if (readdirSync(input.controllerScratch).length !== 0) {
      throw new Error("controller scratch must be empty");
    }
    permissionProfile = buildCloudCodexPermissionProfile({
      codexHome,
      controllerScratch: input.controllerScratch,
      controllerAuthorityRoots: [
        dirname(input.controllerScratch),
        process.cwd(),
        input.controllerEnv.HOME,
        input.controllerEnv.XDG_CONFIG_HOME,
        input.controllerEnv.XDG_CACHE_HOME,
      ],
    });
  } catch {
    throw new CloudWorkspaceError(
      input.provider.name,
      "controller_isolation_unproven",
      "Codex cloud permission profile could not be constructed from the isolated runtime",
      "blocked",
    );
  }
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
    permissionProfile,
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
      reasoningEffort: input.reasoningEffort,
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
    if (error instanceof CodexPermissionAttestationError) {
      throw new CloudWorkspaceError(
        input.provider.name,
        "controller_isolation_unproven",
        error.message,
        "blocked",
      );
    }
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
