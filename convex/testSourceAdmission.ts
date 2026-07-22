import type { TestConvex } from "convex-test";
import type schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  SOURCE_ADMISSION_PROTOCOL_VERSION,
  canonicalProjectIdForRepository,
  evidenceProjectSourceAdmission,
  sealProjectSourceAdmission,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";

type ConvexFixture = TestConvex<typeof schema>;

const missionCache = new WeakMap<object, Map<string, Promise<{
  missionId: Id<"missions">;
  projectAdmission: ProjectSourceAdmission;
}>>>();

export async function testProjectSourceAdmission(
  repository?: string,
  sourceHeadSha = "a".repeat(40),
): Promise<ProjectSourceAdmission> {
  if (!repository) return await evidenceProjectSourceAdmission(Date.now());
  const canonicalProjectId = canonicalProjectIdForRepository(repository);
  if (!canonicalProjectId) throw new Error(`Test repository is not admitted: ${repository}`);
  return await sealProjectSourceAdmission({
    protocolVersion: SOURCE_ADMISSION_PROTOCOL_VERSION,
    canonicalProjectId,
    repository,
    sourceProvider: "github",
    sourceBranch: "main",
    sourceRef: "refs/heads/main",
    sourceHeadSha,
    sourceObservedAt: Date.now(),
  });
}

/** One immutable mission per human fixture key; labels never become ids. */
export async function testMissionAdmission(
  t: ConvexFixture,
  args: { key: string; workerToken: string; repository?: string; sourceHeadSha?: string },
) {
  let cache = missionCache.get(t);
  if (!cache) {
    cache = new Map();
    missionCache.set(t, cache);
  }
  const cacheKey = `${args.key}\u0000${args.repository ?? "evidence"}\u0000${args.sourceHeadSha ?? ""}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const projectAdmission = await testProjectSourceAdmission(args.repository, args.sourceHeadSha);
      const missionId = await t.mutation(api.missions.create, {
        goal: `Test mission ${args.key}`,
        agentCount: 1,
        mode: "fleet",
        projectAdmissions: [projectAdmission],
        workerToken: args.workerToken,
      }) as Id<"missions">;
      return { missionId, projectAdmission };
    })();
    cache.set(cacheKey, pending);
  }
  return await pending;
}
