import { isAbsolute, resolve, sep } from "node:path";

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MINIMUM_SECRET_LENGTH = 32;

export type SelfHostedForegroundConfig = {
  instanceId: string;
  stateDirectory: string;
  convexUrl: string;
};

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`self-hosted foreground configuration missing ${key}`);
  return value;
}

function requiredSecret(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): void {
  if (required(environment, key).length < MINIMUM_SECRET_LENGTH) {
    throw new Error(`self-hosted foreground configuration rejects short ${key}`);
  }
}

function safeStateDirectory(raw: string, workingDirectory: string): string {
  if (!isAbsolute(raw)) throw new Error("self-hosted foreground state directory must be absolute");
  const stateDirectory = resolve(raw);
  const checkout = resolve(workingDirectory);
  if (
    stateDirectory === "/"
    || stateDirectory === checkout
    || stateDirectory.startsWith(`${checkout}${sep}`)
    || stateDirectory === "/tmp/work"
    || stateDirectory.startsWith(`/tmp/work${sep}`)
  ) {
    throw new Error("self-hosted foreground state directory is unsafe");
  }
  return stateDirectory;
}

export function readSelfHostedForegroundConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): SelfHostedForegroundConfig {
  if (required(environment, "JARVIS_SELF_HOSTED_FOREGROUND") !== "live") {
    throw new Error("self-hosted foreground runner is not explicitly enabled");
  }
  if (required(environment, "JARVIS_CODEX_SESSION_SOURCE") !== "vault-broker") {
    throw new Error("self-hosted foreground runner requires the vault broker");
  }
  const instanceId = required(environment, "JARVIS_SELF_HOSTED_FOREGROUND_INSTANCE");
  if (!INSTANCE_PATTERN.test(instanceId)) {
    throw new Error("self-hosted foreground instance is invalid");
  }
  requiredSecret(environment, "JARVIS_WORKER_TOKEN");
  requiredSecret(environment, "JARVIS_DISPATCH_TOKEN");
  requiredSecret(environment, "VAULT_ACCESS_TOKEN");

  const convexUrl = (
    environment.CONVEX_URL?.trim()
    || environment.NEXT_PUBLIC_CONVEX_URL?.trim()
    || ""
  );
  let parsed: URL;
  try {
    parsed = new URL(convexUrl);
  } catch {
    throw new Error("self-hosted foreground Convex URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("self-hosted foreground Convex URL must be a plain HTTPS origin");
  }
  if (parsed.pathname !== "/") {
    throw new Error("self-hosted foreground Convex URL must not include a path");
  }

  return {
    instanceId,
    stateDirectory: safeStateDirectory(
      required(environment, "JARVIS_SELF_HOSTED_FOREGROUND_STATE_DIR"),
      workingDirectory,
    ),
    convexUrl: parsed.origin,
  };
}
