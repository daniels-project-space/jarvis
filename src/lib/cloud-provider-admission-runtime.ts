import "server-only";
import { envvars } from "@trigger.dev/sdk/v3";
import {
  cloudProviderAdmissionReadiness,
  type CloudProviderAdmissionReadiness,
} from "./cloud-provider-admission";

const PROOF_VARIABLES = [
  "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID",
  "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT",
] as const;
const TRIGGER_PROJECT_REF = process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_wjwbdgeipgpddvrazxnp";
const TRIGGER_PRODUCTION_ENVIRONMENT = "prod";

type StoredEnvironmentVariable = Readonly<{ name: string; value: string; isSecret: boolean }>;

type RuntimeDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  retrieve: (name: string) => Promise<StoredEnvironmentVariable>;
}>;

function readable(name: string, value: StoredEnvironmentVariable): string | null {
  return value.name === name && value.isSecret === false && typeof value.value === "string"
    ? value.value
    : null;
}

/**
 * Goal Mode reads its mutable, deployment-bound proof from Trigger rather than
 * copying it through another Vercel deployment. Static provider identity stays
 * in the app environment; an unavailable or secret/redacted runtime proof is
 * a fail-closed admission hold.
 */
export async function cloudProviderAdmissionReadinessAtRuntime(
  overrides: Partial<RuntimeDependencies> = {},
): Promise<CloudProviderAdmissionReadiness> {
  const dependencies: RuntimeDependencies = {
    environment: process.env,
    // Vercel has no Trigger task context, so this must use the explicit
    // project/environment overload. The SDK then authenticates with the
    // server-only TRIGGER_SECRET_KEY already used by owner control routes.
    retrieve: async (name) => await envvars.retrieve(TRIGGER_PROJECT_REF, TRIGGER_PRODUCTION_ENVIRONMENT, name),
    ...overrides,
  };
  try {
    const values = await Promise.all(PROOF_VARIABLES.map(async (name) => [
      name,
      readable(name, await dependencies.retrieve(name)),
    ] as const));
    const proof = Object.fromEntries(values);
    if (Object.values(proof).some((value) => value === null)) {
      return cloudProviderAdmissionReadiness({
        ...dependencies.environment,
        JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "",
        JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "",
      });
    }
    return cloudProviderAdmissionReadiness({
      ...dependencies.environment,
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: proof.JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID ?? "",
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: proof.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT ?? "",
    });
  } catch {
    return cloudProviderAdmissionReadiness({
      ...dependencies.environment,
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: "",
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "",
    });
  }
}
