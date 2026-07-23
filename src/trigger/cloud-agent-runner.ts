import { dirname } from "node:path";
import { readdirSync } from "node:fs";
import {
  CodexAppServer,
  CodexPermissionAttestationError,
  CodexRequestOutcomeUnknownError,
  CodexRequestRejectedError,
} from "./codex-app-server";
import { buildCloudCodexPermissionProfile } from "./cloud-codex-permissions";
import { CloudWorkspaceToolBridge, CLOUD_REPOSITORY_TOOLS } from "./cloud-workspace-tools";
import { CloudWorkspaceError, type CloudWorkspace, type CloudWorkspaceProvider } from "./cloud-workspace";
import { consumeSubscriptionAuth, isCodexUnauthorizedError } from "./subscription-runtime";

export type CloudAgentRun = {
  text: string;
  timedOut: boolean;
  stopped: "paused" | "cancelled" | "stalled" | "steered" | null;
  checkpointLog: string;
  commands: [];
};

export type CloudCodexTurnReceipt = {
  beforeRequest(): Promise<void>;
  requestWritten(): void;
  accepted(): Promise<void>;
  effect(): Promise<void>;
  rejected(): Promise<void>;
  completed(): Promise<void>;
};

export class CloudCodexPreStartAuthorizationError extends Error {
  readonly code = "codex_pre_start_authorization_rejected";
  readonly retrySafe = true;
  constructor() {
    super("Codex subscription authorization was proven rejected before turn acceptance");
    this.name = "CloudCodexPreStartAuthorizationError";
  }
}

export class CloudCodexReplayUnsafeError extends Error {
  readonly code = "codex_turn_reconciliation_required";
  readonly checkpointRequired = true;
  constructor() {
    super("Codex turn outcome requires portable checkpoint reconciliation; replay is forbidden");
    this.name = "CloudCodexReplayUnsafeError";
  }
}

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
  turnReceipt?: CloudCodexTurnReceipt;
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
  let requestIntent = false;
  let requestWritten = false;
  let accepted = false;
  let effect = false;
  let rejected = false;
  const bridge = new CloudWorkspaceToolBridge(input.provider, input.workspace, {
    signal: abort.signal,
    beforeTool: async () => {
      const state = await input.executionState?.() ?? "running";
      if (state !== "running") {
        return state === "cancelled" ? "cancelled" : state === "steered" ? "steered" : "stale";
      }
      await input.turnReceipt?.effect();
      effect = true;
      return "running";
    },
  });
  const server = new CodexAppServer(input.bin, input.controllerEnv, input.timeoutMs, {
    dynamicTools: CLOUD_REPOSITORY_TOOLS,
    onDynamicToolCall: (call) => bridge.invoke(call),
    controllerCwd: input.controllerScratch,
    permissionProfile,
    ephemeral: true,
    onAuthConsumed: () => consumeSubscriptionAuth(input.controllerEnv),
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
      beforeTurn: async () => {
        await input.turnReceipt?.beforeRequest();
        requestIntent = true;
      },
      onTurnRequestWritten: () => {
        requestWritten = true;
        input.turnReceipt?.requestWritten();
      },
      onTurnAccepted: async () => {
        await input.turnReceipt?.accepted();
        accepted = true;
      },
      onDelta: (delta) => {
        log = (log + delta).slice(-12_000);
        input.onProgress?.(delta.trim().replace(/\s+/g, " ").slice(-160) || "working", log, "executing", 60);
      },
    });
    if (turn.code !== 0 && isCodexUnauthorizedError(turn.stderr)) {
      throw new CloudCodexReplayUnsafeError();
    }
    await input.turnReceipt?.completed();
    return {
      text: turn.finalText || (turn.code === 0 ? "(no output)" : `error: ${turn.stderr}`),
      timedOut: Date.now() - startedAt >= input.timeoutMs,
      stopped,
      checkpointLog: log,
      commands: [],
    };
  } catch (error) {
    const provenPreStartRejection = error instanceof CodexRequestRejectedError
      && ["thread/start", "turn/start"].includes(error.method)
      && !accepted && !effect;
    if (provenPreStartRejection) {
      await input.turnReceipt?.rejected();
      rejected = true;
      if (isCodexUnauthorizedError(error)) throw new CloudCodexPreStartAuthorizationError();
    }
    if (requestIntent && !requestWritten && !accepted && !effect && !rejected) {
      // A synchronous local write failure happened after durable intent but
      // before any protocol bytes crossed. Close that intent without treating
      // the provider outcome as ambiguous.
      await input.turnReceipt?.rejected();
    }
    if (error instanceof CloudCodexReplayUnsafeError
      || error instanceof CodexRequestOutcomeUnknownError
      || accepted || effect || requestWritten) {
      throw new CloudCodexReplayUnsafeError();
    }
    if (isCodexUnauthorizedError(error)) throw error;
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
