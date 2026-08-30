import { task } from "@trigger.dev/sdk/v3";
import {
  codexSessionUnavailableCode,
  controllerSessionAutonomousWorkStatus,
  isCodexSessionUnavailableCode,
  type CodexSessionUnavailableCode,
} from "../lib/codex-session-status";
import { resolveConvexUrl } from "../lib/convex-url";
import {
  cleanupSubscriptionHome,
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
} from "./subscription-runtime";
import { backgroundSubscriptionValidityMs } from "./subscription-validity";
import { configuredCloudWorkspaceProviderForCurrentTriggerDeployment } from "./cloud-workspace-providers";
import type { CloudProviderRuntimeAttestation } from "./cloud-provider-probe-attestation";

/**
 * A short window proves the broker can provide a fresh consumer snapshot
 * without starting a model turn. It is deliberately longer than the pinned
 * CLI refresh guard, just as a real background boundary would be.
 */
export const BACKGROUND_READINESS_MINIMUM_VALIDITY_MS = backgroundSubscriptionValidityMs(60_000);

export type BackgroundReadinessBlocker =
  | "worker_token_unavailable"
  | "controller_session_status_unavailable"
  | "codex_binary_unavailable"
  | "subscription_unavailable"
  | "codex_preflight_failed"
  | "consumer_cleanup_failed"
  | "cloud_workspace_unavailable"
  | CodexSessionUnavailableCode;

export type BackgroundReadinessReport = {
  ready: boolean;
  controllerSession: "clear" | "repair_required" | "unknown";
  blocker?: BackgroundReadinessBlocker;
  workspace: "ready" | "unavailable" | "not_checked";
  codex: {
    binary: "available" | "unavailable" | "not_checked";
    subscription: "acquired" | "unavailable" | "not_checked";
    preflight: "passed" | "failed" | "not_checked";
  };
};

type ReadinessFetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type BackgroundReadinessDependencies = {
  environment: Readonly<NodeJS.ProcessEnv>;
  fetch(url: string, init: RequestInit): Promise<ReadinessFetchResponse>;
  resolveSubscriptionAgentBin: typeof resolveSubscriptionAgentBin;
  prepareSubscriptionEnv: typeof prepareSubscriptionEnv;
  verifyCodexSubscriptionPreflight: typeof verifyCodexSubscriptionPreflight;
  cleanupSubscriptionHome: typeof cleanupSubscriptionHome;
  verifyCloudWorkspace: (
    environment: Readonly<NodeJS.ProcessEnv>,
    runtime: CloudProviderRuntimeAttestation,
  ) => Promise<void>;
};

function productionDependencies(): BackgroundReadinessDependencies {
  return {
    environment: process.env,
    fetch: async (url, init) => await fetch(url, init),
    resolveSubscriptionAgentBin,
    prepareSubscriptionEnv,
    verifyCodexSubscriptionPreflight,
    cleanupSubscriptionHome,
    verifyCloudWorkspace: async (environment, runtime) => {
      await configuredCloudWorkspaceProviderForCurrentTriggerDeployment(environment, runtime);
    },
  };
}

function unknownControllerReport(blocker: BackgroundReadinessBlocker): BackgroundReadinessReport {
  return {
    ready: false,
    controllerSession: "unknown",
    blocker,
    workspace: "not_checked",
    codex: { binary: "not_checked", subscription: "not_checked", preflight: "not_checked" },
  };
}

type ControllerSessionObservation = {
  state: "clear" | "repair_required" | "unknown";
  code?: CodexSessionUnavailableCode;
};

async function controllerSessionStatus(
  dependencies: BackgroundReadinessDependencies,
): Promise<ControllerSessionObservation> {
  const workerToken = dependencies.environment.JARVIS_WORKER_TOKEN;
  if (!workerToken) return { state: "unknown" };
  const convexUrl = resolveConvexUrl(
    dependencies.environment.CONVEX_URL,
    dependencies.environment.NEXT_PUBLIC_CONVEX_URL,
  );
  try {
    const response = await dependencies.fetch(`${convexUrl}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "controllerSession:status",
        args: { workerToken },
        format: "json",
      }),
    });
    if (!response.ok) return { state: "unknown" };
    const payload = await response.json();
    const value = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).value
      : undefined;
    const state = controllerSessionAutonomousWorkStatus(value);
    const code = state === "repair_required" && typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).code
      : undefined;
    return state === "repair_required" && isCodexSessionUnavailableCode(code)
      ? { state, code }
      : { state };
  } catch {
    return { state: "unknown" };
  }
}

function reportForSessionHold(code: CodexSessionUnavailableCode): BackgroundReadinessReport {
  return {
    ready: false,
    controllerSession: "repair_required",
    blocker: code,
    workspace: "not_checked",
    codex: { binary: "not_checked", subscription: "not_checked", preflight: "not_checked" },
  };
}

/**
 * Performs only the background worker's no-cost prerequisites. It never
 * reserves a job, creates a cloud workspace, starts a Codex turn, or invokes
 * a model. The exact consumer home is always cleaned before reporting ready.
 */
export async function runBackgroundReadinessProbe(
  dependencies: BackgroundReadinessDependencies = productionDependencies(),
  runtime: CloudProviderRuntimeAttestation = { triggerDeploymentVersion: undefined },
): Promise<BackgroundReadinessReport> {
  if (!dependencies.environment.JARVIS_WORKER_TOKEN) {
    return unknownControllerReport("worker_token_unavailable");
  }

  const controller = await controllerSessionStatus(dependencies);
  if (controller.state === "repair_required" && controller.code) {
    return reportForSessionHold(controller.code);
  }
  if (controller.state === "repair_required") {
    return unknownControllerReport("controller_session_status_unavailable");
  }
  if (controller.state !== "clear") {
    return unknownControllerReport("controller_session_status_unavailable");
  }
  const controllerSession = controller.state;

  try {
    // This is a local/control-plane verification only: it validates the exact
    // current Trigger deployment receipt, pinned provider SDK and configured
    // adapter without creating a workspace or making a provider lifecycle
    // call. A session-only check must never authorize autonomous queues that
    // have no executable workspace behind them.
    await dependencies.verifyCloudWorkspace(dependencies.environment, runtime);
  } catch {
    return {
      ready: false,
      controllerSession,
      blocker: "cloud_workspace_unavailable",
      workspace: "unavailable",
      codex: { binary: "not_checked", subscription: "not_checked", preflight: "not_checked" },
    };
  }

  const bin = dependencies.resolveSubscriptionAgentBin("codex");
  if (!bin) {
    return {
      ready: false,
      controllerSession,
      blocker: "codex_binary_unavailable",
      workspace: "ready",
      codex: { binary: "unavailable", subscription: "not_checked", preflight: "not_checked" },
    };
  }

  let prepared: Awaited<ReturnType<BackgroundReadinessDependencies["prepareSubscriptionEnv"]>>;
  try {
    prepared = await dependencies.prepareSubscriptionEnv("codex", {
      scope: "background-readiness",
      minimumValidityMs: BACKGROUND_READINESS_MINIMUM_VALIDITY_MS,
      environment: dependencies.environment,
    });
  } catch {
    return {
      ready: false,
      controllerSession,
      blocker: "subscription_unavailable",
      workspace: "ready",
      codex: { binary: "available", subscription: "unavailable", preflight: "not_checked" },
    };
  }
  let report: BackgroundReadinessReport = {
    ready: false,
    controllerSession,
    blocker: "subscription_unavailable",
    workspace: "ready",
    codex: { binary: "available", subscription: "unavailable", preflight: "not_checked" },
  };
  try {
    if (prepared.error) {
      report = {
        ready: false,
        controllerSession,
        blocker: codexSessionUnavailableCode(prepared.error) ?? "subscription_unavailable",
        workspace: "ready",
        codex: { binary: "available", subscription: "unavailable", preflight: "not_checked" },
      };
    } else {
      try {
        const preflight = dependencies.verifyCodexSubscriptionPreflight(bin, prepared.env);
        report = preflight.error
          ? {
            ready: false,
            controllerSession,
            blocker: "codex_preflight_failed",
            workspace: "ready",
            codex: { binary: "available", subscription: "acquired", preflight: "failed" },
          }
          : {
            ready: true,
            controllerSession,
            workspace: "ready",
            codex: { binary: "available", subscription: "acquired", preflight: "passed" },
          };
      } catch {
        report = {
          ready: false,
          controllerSession,
          blocker: "codex_preflight_failed",
          workspace: "ready",
          codex: { binary: "available", subscription: "acquired", preflight: "failed" },
        };
      }
    }
  } finally {
    try {
      dependencies.cleanupSubscriptionHome(prepared.env);
    } catch {
      report = {
        ready: false,
        controllerSession,
        blocker: "consumer_cleanup_failed",
        workspace: "ready",
        codex: { binary: "available", subscription: prepared.error ? "unavailable" : "acquired", preflight: "not_checked" },
      };
    }
  }
  return report;
}

// This task is intentionally unscheduled and is only reachable through a
// privileged Trigger invocation. It makes no job, provider, or model call.
export const backgroundReadiness = task({
  id: "jarvis-background-readiness",
  machine: "micro",
  retry: { maxAttempts: 1 },
  maxDuration: 45,
  run: async (_payload, { ctx }) => await runBackgroundReadinessProbe(
    productionDependencies(),
    { triggerDeploymentVersion: ctx.deployment?.version },
  ),
});
