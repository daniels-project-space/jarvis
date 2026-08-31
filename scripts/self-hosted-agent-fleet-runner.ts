import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { issueLiveCloudProviderProbe } from "./probe-cloud-workspace-provider";
import { reserveAgentFleetBatch, type AgentFleetReservation } from "../src/lib/agent-fleet-dispatch";
import { redactSensitiveText } from "../src/lib/secret-redaction";
import { readSelfHostedAgentFleetConfig } from "../src/lib/self-hosted-agent-fleet-config";
import { runSelfHostedAgentFleetController } from "../src/lib/self-hosted-agent-fleet";
import {
  AGENT_WORKER_SOFT_DEADLINE_MS,
  createProductionAgentRunnerDependencies,
  runAgentHarness,
  runAgentMaintenance,
} from "../src/trigger/agent-runner";
import {
  createProductionMissionSupervisorTickDependencies,
  createSupervisorConvexClient,
  runMissionSupervisorDeadmanSweep,
  runMissionSupervisorTickForRollout,
} from "../src/trigger/mission-supervisor";
import { configuredCloudWorkspaceProvider } from "../src/trigger/cloud-workspace-providers";
import type { CloudProviderProbeEnvelope } from "../src/trigger/cloud-provider-probe-attestation";

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function workerMutation<T>(
  convexUrl: string,
  path: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("self-hosted agent fleet worker capability is unavailable");
  const response = await fetch(`${convexUrl}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...args, workerToken }, format: "json" }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as { status?: unknown; value?: unknown } | null;
  if (!response.ok || payload?.status !== "success") {
    throw new Error(`self-hosted agent fleet mutation ${path} failed`);
  }
  return payload.value as T;
}

function runnerDependencies(probe: CloudProviderProbeEnvelope) {
  const production = createProductionAgentRunnerDependencies();
  const receipt = JSON.stringify(probe);
  return {
    ...production,
    configuredCloudWorkspaceProvider: (
      environment: Readonly<Record<string, string | undefined>>,
      runtimeAttestation: { triggerDeploymentVersion: string | null | undefined },
    ) => configuredCloudWorkspaceProvider({
      ...environment,
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: receipt,
    }, runtimeAttestation),
  };
}

export async function runSelfHostedAgentFleet(): Promise<void> {
  const config = readSelfHostedAgentFleetConfig();
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDirectory, 0o700);

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let liveProbe: CloudProviderProbeEnvelope | null = null;
  const runtimeAttestation = {
    triggerDeploymentVersion: config.controllerDeploymentId,
  } as const;
  const supervisorConvex = createSupervisorConvexClient({ url: config.convexUrl });

  try {
    await runSelfHostedAgentFleetController(config.pollMs, shutdown.signal, {
      activateProtocol: async () => {
        await workerMutation(config.convexUrl, "jobs:activateHeartbeatProtocolV2", {
          triggerDeploymentVersion: config.controllerDeploymentId,
        });
      },
      validateProvider: async () => {
        const probe = await issueLiveCloudProviderProbe(process.env);
        const provider = configuredCloudWorkspaceProvider({
          ...process.env,
          JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: JSON.stringify(probe),
        }, runtimeAttestation);
        if (provider.name !== "selfhost") {
          throw new Error("self-hosted agent fleet provider proof selected the wrong runtime");
        }
        liveProbe = probe;
      },
      resumeProviderHolds: async () => {
        if (!liveProbe) throw new Error("self-hosted agent fleet provider proof is unavailable");
        await workerMutation(config.convexUrl, "jobs:resumeCloudWorkspaceBlocks", { limit: 8 });
      },
      runMaintenance: async () => {
        await runAgentMaintenance();
      },
      runSupervisorSweep: async (signal) => {
        await runMissionSupervisorDeadmanSweep(() => ({
          convex: supervisorConvex,
          dispatchTick: async (payload, options) => {
            const identity = createHash("sha256")
              .update(options.idempotencyKey)
              .digest("hex")
              .slice(0, 32);
            const runId = `selfhost-supervisor:${config.instanceId}:${identity}`;
            await runMissionSupervisorTickForRollout(
              payload,
              {
                runId,
                deploymentVersion: config.controllerDeploymentId,
                signal,
              },
              createProductionMissionSupervisorTickDependencies,
              async () => true,
            );
            return { id: runId };
          },
        }));
      },
      reserve: reserveAgentFleetBatch,
      runJob: async (reservation: AgentFleetReservation) => {
        if (!liveProbe) throw new Error("self-hosted agent fleet provider proof is unavailable");
        const workerRunId = `selfhost-agent:${config.instanceId}:${randomUUID()}`.slice(0, 120);
        process.stdout.write(JSON.stringify({
          status: "claimed",
          runtime: "selfhost",
          jobId: reservation.jobId,
          missionId: reservation.missionId,
          agentId: reservation.agentId,
        }) + "\n");
        await runAgentHarness({
          reservation: {
            ...reservation,
            workerRunId,
            workerRuntime: "selfhost",
            triggerObservedMachinePreset: reservation.triggerMachinePreset,
            triggerPlatformAttempt: 1,
          },
          runtimeAttestation,
          dependencies: runnerDependencies(liveProbe),
          workerDeadlineAt: Date.now() + AGENT_WORKER_SOFT_DEADLINE_MS,
          onProgress: (progress) => {
            process.stdout.write(JSON.stringify({
              status: "running",
              runtime: "selfhost",
              jobId: progress.jobId,
              missionId: progress.missionId ?? null,
              agentId: progress.agentId ?? null,
              stage: progress.stage ?? "working",
              percent: progress.percent ?? 0,
            }) + "\n");
          },
        });
        process.stdout.write(JSON.stringify({
          status: "cycle-complete",
          runtime: "selfhost",
          jobId: reservation.jobId,
        }) + "\n");
      },
      wait,
      now: Date.now,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runSelfHostedAgentFleet().catch((error) => {
    const reason = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
      process.env,
    ).slice(0, 360);
    process.stderr.write(JSON.stringify({
      status: "stopped",
      runtime: "selfhost",
      reason: reason || "fail-closed controller error",
    }) + "\n");
    process.exitCode = 1;
  });
}
