import { isAbsolute, resolve, sep } from "node:path";

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEPLOYMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MINIMUM_SECRET_LENGTH = 32;

export type SelfHostedAgentFleetConfig = {
  instanceId: string;
  stateDirectory: string;
  convexUrl: string;
  controllerDeploymentId: string;
  admitCreatedAtOrAfter: number;
  pollMs: number;
};

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`self-hosted agent fleet configuration missing ${key}`);
  return value;
}

function requiredSecret(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): void {
  if (required(environment, key).length < MINIMUM_SECRET_LENGTH) {
    throw new Error(`self-hosted agent fleet configuration rejects short ${key}`);
  }
}

function safeStateDirectory(raw: string, workingDirectory: string): string {
  if (!isAbsolute(raw)) throw new Error("self-hosted agent fleet state directory must be absolute");
  const stateDirectory = resolve(raw);
  const checkout = resolve(workingDirectory);
  if (
    stateDirectory === "/"
    || stateDirectory === checkout
    || stateDirectory.startsWith(`${checkout}${sep}`)
    || stateDirectory === "/tmp/work"
    || stateDirectory.startsWith(`/tmp/work${sep}`)
  ) {
    throw new Error("self-hosted agent fleet state directory is unsafe");
  }
  return stateDirectory;
}

function convexOrigin(environment: Readonly<Record<string, string | undefined>>): string {
  const raw = environment.CONVEX_URL?.trim() || environment.NEXT_PUBLIC_CONVEX_URL?.trim() || "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("self-hosted agent fleet Convex URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/"
  ) {
    throw new Error("self-hosted agent fleet Convex URL must be a plain HTTPS origin");
  }
  return parsed.origin;
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("self-hosted agent fleet polling interval is outside its safe bound");
  }
  return value;
}

function activationCutoff(raw: string | undefined): number {
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < 1_700_000_000_000
    || value > Date.now() + 5 * 60_000
  ) {
    throw new Error("self-hosted agent fleet admission cutoff is invalid");
  }
  return value;
}

export function readSelfHostedAgentFleetConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): SelfHostedAgentFleetConfig {
  if (required(environment, "JARVIS_SELF_HOSTED_AGENT_FLEET") !== "live") {
    throw new Error("self-hosted agent fleet is not explicitly enabled");
  }
  if (required(environment, "JARVIS_CODEX_SESSION_SOURCE") !== "vault-broker") {
    throw new Error("self-hosted agent fleet requires the vault broker");
  }
  if (required(environment, "JARVIS_CLOUD_WORKSPACE_PROVIDER") !== "selfhost") {
    throw new Error("self-hosted agent fleet requires the isolated selfhost workspace provider");
  }
  if (required(environment, "JARVIS_CLOUD_PROVIDER_PROBE") !== "live") {
    throw new Error("self-hosted agent fleet requires live provider proof");
  }

  const instanceId = required(environment, "JARVIS_SELF_HOSTED_AGENT_FLEET_INSTANCE");
  if (!INSTANCE_PATTERN.test(instanceId)) {
    throw new Error("self-hosted agent fleet instance is invalid");
  }
  const controllerDeploymentId = required(environment, "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID");
  if (!DEPLOYMENT_PATTERN.test(controllerDeploymentId)) {
    throw new Error("self-hosted agent fleet deployment identity is invalid");
  }
  if (!SHA256.test(required(environment, "JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST").toLowerCase())) {
    throw new Error("self-hosted agent fleet template digest is invalid");
  }
  required(environment, "JARVIS_CLOUD_WORKSPACE_TEMPLATE");
  required(environment, "JARVIS_CLOUD_PROVIDER_PROBE_KEYRING");
  required(environment, "JARVIS_SELF_HOST_RUNNER_URL");
  requiredSecret(environment, "JARVIS_SELF_HOST_RUNNER_TOKEN");
  requiredSecret(environment, "JARVIS_WORKER_TOKEN");
  requiredSecret(environment, "JARVIS_DISPATCH_TOKEN");
  requiredSecret(environment, "VAULT_ACCESS_TOKEN");

  return {
    instanceId,
    stateDirectory: safeStateDirectory(
      required(environment, "JARVIS_SELF_HOSTED_AGENT_FLEET_STATE_DIR"),
      workingDirectory,
    ),
    convexUrl: convexOrigin(environment),
    controllerDeploymentId,
    admitCreatedAtOrAfter: activationCutoff(
      environment.JARVIS_SELF_HOSTED_AGENT_FLEET_NOT_BEFORE_MS,
    ),
    pollMs: boundedInteger(environment.JARVIS_SELF_HOSTED_AGENT_FLEET_POLL_MS, 2_000, 250, 30_000),
  };
}
