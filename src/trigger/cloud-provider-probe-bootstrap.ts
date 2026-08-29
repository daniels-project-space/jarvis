import { envvars, metadata, task } from "@trigger.dev/sdk/v3";
import { vaultService } from "../lib/vault-client";
import { configuredCloudWorkspaceProviderName } from "../lib/cloud-provider-selection";
import { actualTriggerDeploymentId } from "./cloud-provider-probe-attestation";
import { issueLiveCloudProviderProbe } from "../../scripts/probe-cloud-workspace-provider";

const OWNER_CAPABILITY_NAME = "CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY";
const OWNER_CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;

type RuntimeContext = Readonly<{ triggerDeploymentVersion: string | null | undefined }>;
type StoredEnvironmentVariable = Readonly<{ name: string; value: string; isSecret: boolean }>;

type BootstrapDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  loadVault: (service: string) => Promise<Record<string, string>>;
  issueProbe: typeof issueLiveCloudProviderProbe;
  uploadEnvironment: (params: { variables: Record<string, string>; override: boolean }) => Promise<unknown>;
  retrieveEnvironment: (name: string) => Promise<StoredEnvironmentVariable>;
}>;

function ownerBootstrapAuthorized(values: Readonly<Record<string, string>>): boolean {
  return OWNER_CAPABILITY.test(String(values[OWNER_CAPABILITY_NAME] ?? ""));
}

function storedExactly(name: string, expected: string, value: StoredEnvironmentVariable): boolean {
  return value.name === name && value.isSecret === false && value.value === expected;
}

/**
 * This is intentionally an owner-operated deployment bootstrap, not a user
 * tool: its Trigger task has no payload and requires a separate Vault-only
 * capability in addition to the exact live-probe opt-in.
 */
export async function bootstrapCurrentCloudProviderProbe(
  runtime: RuntimeContext,
  overrides: Partial<BootstrapDependencies> = {},
): Promise<{ status: "attested"; deploymentId: string }> {
  const dependencies: BootstrapDependencies = {
    environment: process.env,
    loadVault: vaultService,
    issueProbe: issueLiveCloudProviderProbe,
    uploadEnvironment: async (params) => await envvars.upload(params),
    retrieveEnvironment: async (name) => await envvars.retrieve(name),
    ...overrides,
  };
  if (dependencies.environment.JARVIS_CLOUD_PROVIDER_PROBE !== "live") {
    throw new Error("live cloud provider probe bootstrap is not enabled");
  }
  const vault = await dependencies.loadVault("jarvis");
  if (!ownerBootstrapAuthorized(vault)) {
    throw new Error("owner cloud provider probe capability is unavailable");
  }

  const provider = configuredCloudWorkspaceProviderName(dependencies.environment) ?? "cloudflare";
  const deploymentId = actualTriggerDeploymentId(runtime, provider);
  const envelope = await dependencies.issueProbe({
    ...dependencies.environment,
    JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: deploymentId,
  });
  if (envelope.receipt.deploymentId !== deploymentId) {
    throw new Error("live cloud provider probe did not bind to the current Trigger deployment");
  }

  const receipt = JSON.stringify(envelope);
  await dependencies.uploadEnvironment({
    variables: {
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: deploymentId,
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: receipt,
    },
    override: true,
  });
  const [storedDeploymentId, storedReceipt] = await Promise.all([
    dependencies.retrieveEnvironment("JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID"),
    dependencies.retrieveEnvironment("JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT"),
  ]);
  if (!storedExactly("JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID", deploymentId, storedDeploymentId)
    || !storedExactly("JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT", receipt, storedReceipt)) {
    throw new Error("current Trigger cloud provider proof was not published as readable non-secret evidence");
  }
  return { status: "attested", deploymentId };
}

export const cloudProviderProbeBootstrap = task({
  id: "jarvis-cloud-provider-probe-bootstrap",
  maxDuration: 900,
  retry: { maxAttempts: 0 },
  queue: { name: "jarvis-cloud-provider-probe-bootstrap", concurrencyLimit: 1 },
  run: async (_payload, { ctx }) => {
    metadata.set("status", "attesting-current-deployment");
    const result = await bootstrapCurrentCloudProviderProbe({
      triggerDeploymentVersion: ctx.deployment?.version,
    });
    metadata.set("status", "attested").set("deploymentId", result.deploymentId);
    return result;
  },
});
