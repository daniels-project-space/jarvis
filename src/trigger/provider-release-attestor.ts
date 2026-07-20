import { task } from "@trigger.dev/sdk/v3";
import { PROJECT_BY_SLUG } from "../lib/project-registry";

type ProviderReleaseAttestation = {
  protocol: 1;
  releaseId: string;
  expectedSourceSha: string;
  expectedProjectRef: string;
  expectedVersion: string;
};

/**
 * This task is deliberately tiny. The old release-controller worker launches
 * it against the newly staged version, and the Trigger API independently
 * reports the version that actually executed it. The source SHA comes from
 * trigger.config's build-time sync, so an old running worker cannot attest a
 * replacement task bundle merely by echoing its requested SHA.
 */
export const providerReleaseAttestor = task({
  id: "jarvis-provider-release-attestor",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (payload: ProviderReleaseAttestation, { ctx }) => {
    const projectRef = PROJECT_BY_SLUG.get("jarvis")?.providerBoundary?.release?.trigger?.projectRef ?? "";
    const sourceSha = process.env.JARVIS_RELEASE_SOURCE_SHA ?? "";
    const version = String(ctx.task.version ?? "");
    if (
      payload.protocol !== 1
      || !/^providers-v1:[0-9a-f]{64}$/.test(payload.releaseId)
      || !/^[0-9a-f]{40,64}$/i.test(payload.expectedSourceSha)
      || sourceSha !== payload.expectedSourceSha
      || projectRef !== payload.expectedProjectRef
      || version !== payload.expectedVersion
    ) {
      throw new Error("provider release attestation does not match this deployed task bundle");
    }
    return {
      protocol: 1 as const,
      releaseId: payload.releaseId,
      sourceSha,
      projectRef,
      version,
    };
  },
});

