import { task } from "@trigger.dev/sdk/v3";
import { PROJECT_BY_SLUG } from "../lib/project-registry";
import { runExactSpecialistSandboxSmoke } from "./specialist-sandbox-smoke";

type ProviderReleaseAttestation = {
  protocol: 1;
  releaseId: string;
  expectedSourceSha: string;
  expectedProjectRef: string;
  expectedVersion: string;
};

export function providerReleaseAttestationMatches(input: {
  payload: ProviderReleaseAttestation;
  projectRef: string;
  sourceSha: string;
  version: string;
}): boolean {
  return input.payload.protocol === 1
    && /^providers-v2:[0-9a-f]{64}$/.test(input.payload.releaseId)
    && /^[0-9a-f]{40,64}$/i.test(input.payload.expectedSourceSha)
    && input.sourceSha === input.payload.expectedSourceSha
    && input.projectRef === input.payload.expectedProjectRef
    && input.version === input.payload.expectedVersion;
}

/**
 * This task is deliberately tiny. The old release-controller worker launches
 * it against the newly staged version, and the Trigger API independently
 * reports the version that actually executed it. The source SHA comes from
 * trigger.config's build-time sync, so an old running worker cannot attest a
 * replacement task bundle merely by echoing its requested SHA.
 */
export const providerReleaseAttestor = task({
  id: "jarvis-provider-release-attestor",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async (payload: ProviderReleaseAttestation, { ctx }) => {
    const projectRef = PROJECT_BY_SLUG.get("jarvis")?.providerBoundary?.release?.trigger?.projectRef ?? "";
    const sourceSha = process.env.JARVIS_RELEASE_SOURCE_SHA ?? "";
    const version = String(ctx.task.version ?? "");
    if (!providerReleaseAttestationMatches({ payload, projectRef, sourceSha, version })) {
      throw new Error("provider release attestation does not match this deployed task bundle");
    }
    const sandbox = await runExactSpecialistSandboxSmoke();
    if (!sandbox.ok) throw new Error(sandbox.reason);
    return {
      protocol: 1 as const,
      releaseId: payload.releaseId,
      sourceSha,
      projectRef,
      version,
      sandboxSmoke: true as const,
    };
  },
});
