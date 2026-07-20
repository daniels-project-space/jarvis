import { describe, expect, it, vi } from "vitest";
import { verifiedDeliveryCanFinalize } from "./provider-release-finalization";
import {
  analyseProviderImpact,
  buildProviderReleasePlan,
  providerKindsForPaths,
  runPostMergeReleaseBarrier,
  runProviderReleaseBarrier,
  vercelLiveDeploymentMismatch,
  vercelProjectIdentityMismatch,
  type ProviderReleaseState,
  type ProviderStepReceipt,
} from "./provider-release";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function jarvisPlan(paths: string[], sources?: Record<string, string>) {
  return buildProviderReleasePlan({
    repository: "daniels-project-space/jarvis",
    branch: "jarvis/paul-provider-order",
    baseSha,
    headSha,
    changedPaths: paths,
    sources,
  });
}

describe("trusted provider release planning", () => {
  it("classifies the incident's Convex consumer/index change and Trigger bundles", () => {
    expect(providerKindsForPaths([
      "convex/schema.ts",
      "convex/commandCenter.ts",
      "src/components/JarvisUI.tsx",
    ])).toEqual(["convex"]);
    expect(providerKindsForPaths(["src/trigger/agent-runner.ts", "trigger.config.ts"]))
      .toEqual(["trigger"]);
  });

  it("follows transitive candidate-tree imports into both provider bundles", () => {
    const sources = {
      "convex/jobs.ts": 'import { guard } from "../src/lib/convex-shared"; guard();',
      "src/lib/convex-shared.ts": 'export { guard } from "./work-safety";',
      "src/trigger/agent-runner.ts": 'import { guard } from "../lib/trigger-shared"; guard();',
      "src/lib/trigger-shared.ts": 'export { guard } from "./work-safety";',
      "src/lib/work-safety.ts": "export const guard = () => true;",
      "src/components/OnlyWeb.tsx": "export const OnlyWeb = () => null;",
    };
    expect(analyseProviderImpact(["src/lib/work-safety.ts"], sources).providers)
      .toEqual(["convex", "trigger"]);
    expect(analyseProviderImpact(["src/components/OnlyWeb.tsx"], sources).providers)
      .toEqual([]);
  });

  it("includes non-code assets and runtime file inputs reached through provider bundles", () => {
    const sources = {
      "convex/jobs.ts": 'import schema from "../src/lib/provider-schema.json"; export const value = schema;',
      "src/trigger/agent-runner.ts": 'const worker = new URL("../lib/provider-worker.wasm", import.meta.url); export { worker };',
      "src/lib/provider-schema.json": '{"ok":true}',
      "src/lib/provider-worker.wasm": "",
    };
    expect(analyseProviderImpact([
      "src/lib/provider-schema.json",
      "src/lib/provider-worker.wasm",
    ], sources).providers).toEqual(["convex", "trigger"]);
  });

  it("fails closed for package, lock, root config, and provider build scripts", () => {
    for (const path of ["package.json", "package-lock.json", "packages/shared/package.json", "tsconfig.json", "instrumentation.config.ts", "scripts/release-provider.mjs"]) {
      expect(providerKindsForPaths([path]), path).toEqual(["convex", "trigger"]);
    }
  });

  it("orders Jarvis's exact project-isolated prerequisites before web delivery", () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
    expect(plan).toMatchObject({ required: true, valid: true });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "vercel:team_VY2PwHgXLV9Bo0vs2iXdnGxw:jarvis",
      "convex:canonical:tangible-goose-318",
      "convex:mirror:scintillating-camel-329",
      "trigger:proj_wjwbdgeipgpddvrazxnp",
      "live:vercel:jarvis-orcin-six.vercel.app",
      "live:convex:canonical:tangible-goose-318",
      "live:convex:mirror:scintillating-camel-329",
      "live:trigger:proj_wjwbdgeipgpddvrazxnp",
    ]);
    expect(plan.boundary?.vercel).toMatchObject({
      productionAlias: "jarvis-orcin-six.vercel.app",
      productionBranch: "main",
      gitRepository: "daniels-project-space/jarvis",
    });
  });

  it("declares Dropship AI's exact isolated release boundary using capability names", () => {
    const plan = buildProviderReleasePlan({
      repository: "daniels-project-space/dropship-ai",
      branch: "jarvis/paul-provider-order",
      baseSha,
      headSha,
      changedPaths: ["package-lock.json"],
    });
    expect(plan).toMatchObject({ required: true, valid: true });
    expect(plan.boundary).toMatchObject({
      vercel: { projectId: "prj_506MgOrVxyVJzbnR95z8f853Upp4" },
      convex: { targets: [{ deployment: "peaceful-panda-894" }] },
      trigger: { projectRef: "proj_ebwgqvfufapbqnhjxhnc" },
      r2: { bucket: "dropship-ai" },
    });
    expect(JSON.stringify(plan.boundary)).toContain("dropship-ai-release");
    expect(JSON.stringify(plan.boundary)).not.toMatch(/(?:token|key)_[a-z0-9]{12,}/i);
  });

  it("fails closed when an owned repository has no exact release identity", () => {
    const plan = buildProviderReleasePlan({
      repository: "daniels-project-space/media-engine",
      branch: "jarvis/paul-provider-change",
      baseSha,
      headSha,
      changedPaths: ["convex/schema.ts"],
    });
    expect(plan.required).toBe(true);
    expect(plan.valid).toBe(false);
    expect(plan.note).toContain("exact trusted release boundary is missing");
  });

  it("enforces the stable Vercel project, team, Git route and production alias", () => {
    const boundary = jarvisPlan(["convex/schema.ts"]).boundary!.vercel;
    const observed = {
      id: "prj_JarvisStableId",
      name: "jarvis",
      accountId: "team_VY2PwHgXLV9Bo0vs2iXdnGxw",
      link: {
        type: "github",
        org: "daniels-project-space",
        repo: "jarvis",
        productionBranch: "main",
      },
      alias: [{ domain: "jarvis-orcin-six.vercel.app" }],
    };
    expect(vercelProjectIdentityMismatch(boundary, observed)).toBeNull();
    expect(vercelProjectIdentityMismatch({ ...boundary, projectId: "prj_Expected" }, observed))
      .toContain("wrong stable project id");
    expect(vercelProjectIdentityMismatch(boundary, {
      ...observed,
      link: { ...observed.link, repo: "dropship-ai" },
    })).toContain("does not match");
    expect(vercelProjectIdentityMismatch(boundary, {
      ...observed,
      alias: [{ domain: "another-project.vercel.app" }],
    })).toContain("was not independently observed");
  });

  it("leaves ordinary code-only delivery on the no-prerequisite fast path", async () => {
    const plan = jarvisPlan(["src/components/JarvisUI.tsx", "src/app/page.tsx"]);
    const persist = vi.fn();
    const execute = vi.fn();
    const result = await runProviderReleaseBarrier(plan, undefined, {
      persist,
      execute,
      reverify: vi.fn(),
    });
    expect(result).toEqual({ status: "not_required", note: "no provider bundle or build/runtime input is affected" });
    expect(persist).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("durable two-phase provider barrier", () => {
  it("persists deployment phase before exact prerequisites execute in safe order", async () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
    const premerge = plan.steps.filter((step) => step.phase === "premerge");
    const events: string[] = [];
    const result = await runProviderReleaseBarrier(plan, undefined, {
      persist: async (state) => {
        events.push(`persist:${state.phase}:${state.steps.map((step) => step.status).join(",")}`);
        return true;
      },
      execute: async ({ step }) => {
        events.push(`execute:${step.id}`);
        return { id: step.id, status: "verified", proof: step.target };
      },
      reverify: async ({ prior }) => prior,
      now: () => 100,
    });
    expect(result.status).toBe("ready");
    expect(events[0]).toBe(`persist:deploying:${plan.steps.map(() => "pending").join(",")}`);
    expect(events.filter((event) => event.startsWith("execute:"))).toEqual(
      premerge.map((step) => `execute:${step.id}`),
    );
    expect(events.at(-1)).toContain("persist:premerge_ready:");
  });

  it("fences merge/finalization on provider failure and resumes receipts without implementation", async () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
    const premerge = plan.steps.filter((step) => step.phase === "premerge");
    let failedOnce = false;
    const first = await runProviderReleaseBarrier(plan, undefined, {
      persist: async () => true,
      execute: async ({ step }) => {
        if (step.id.includes("mirror") && !failedOnce) {
          failedOnce = true;
          throw new Error("mirror unavailable");
        }
        return { id: step.id, status: "verified", proof: step.target };
      },
      reverify: async ({ prior }) => prior,
      now: () => 100,
    });
    expect(first.status).toBe("blocked");
    const blocked = first.status === "blocked" ? first.state : undefined;
    expect(blocked?.steps[0].status).toBe("verified");
    expect(blocked?.steps[1].status).toBe("verified");
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "blocked",
      providerRelease: blocked,
    })).toBe(false);

    const executed: string[] = [];
    const reverified: string[] = [];
    const resumed = await runProviderReleaseBarrier(plan, blocked, {
      persist: async () => true,
      execute: async ({ step }) => {
        executed.push(step.id);
        return { id: step.id, status: "verified", proof: step.target };
      },
      reverify: async ({ step, prior }) => {
        reverified.push(step.id);
        return { ...prior, status: "verified" } as ProviderStepReceipt;
      },
      now: () => 200,
    });
    expect(resumed.status).toBe("ready");
    expect(reverified).toEqual(plan.steps.slice(0, 2).map((step) => step.id));
    expect(executed).toEqual(premerge.slice(2).map((step) => step.id));
    expect(resumed.status === "ready" && resumed.state.attempts).toBe(2);
  });

  it("preserves a staged provider handoff when a later operation fails", async () => {
    const plan = jarvisPlan(["src/trigger/agent-runner.ts"]);
    const triggerStep = plan.steps.find((step) => step.phase === "premerge" && step.kind === "trigger")!;
    const version = "20260720.7";
    const first = await runProviderReleaseBarrier(plan, undefined, {
      persist: async () => true,
      execute: async ({ step, checkpoint }) => {
        if (step.kind === "vercel_identity") {
          return { id: step.id, status: "verified", proof: step.target };
        }
        await checkpoint({
          id: step.id,
          status: "deploying",
          version,
          runId: "run_attestor_1",
          proof: "new-version handoff persisted",
          data: { staged: true, pinnedRunId: "run_attestor_1" },
        });
        throw new Error("attestor temporarily unavailable");
      },
      reverify: async ({ prior }) => prior,
      now: () => 100,
    });
    expect(first.status).toBe("blocked");
    const blocked = first.status === "blocked" ? first.state : undefined;
    expect(blocked?.steps.find((step) => step.id === triggerStep.id)).toMatchObject({
      status: "failed",
      version,
      runId: "run_attestor_1",
      data: { staged: true, pinnedRunId: "run_attestor_1" },
    });

    const resumedPriors: ProviderStepReceipt[] = [];
    const resumed = await runProviderReleaseBarrier(plan, blocked, {
      persist: async () => true,
      execute: async ({ step, prior }) => {
        resumedPriors.push(prior);
        return { ...prior, id: step.id, status: "verified", proof: "handoff resumed" };
      },
      reverify: async ({ prior }) => prior,
      now: () => 200,
    });
    expect(resumed.status).toBe("ready");
    expect(resumedPriors).toEqual([
      expect.objectContaining({ version, runId: "run_attestor_1" }),
    ]);
  });

  it("blocks a failed exact post-merge proof and resumes its durable receipts idempotently", async () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
    const premerge = await runProviderReleaseBarrier(plan, undefined, {
      persist: async () => true,
      execute: async ({ step }) => ({ id: step.id, status: "verified", proof: step.target }),
      reverify: async ({ prior }) => prior,
      now: () => 100,
    });
    expect(premerge.status).toBe("ready");
    if (premerge.status !== "ready") throw new Error("pre-merge fixture failed");
    const mergeSha = "d".repeat(40);
    const first = await runPostMergeReleaseBarrier(plan, premerge.state, mergeSha, {
      persist: async () => true,
      execute: async ({ step }) => {
        if (step.id.includes("mirror")) throw new Error("live mirror proof unavailable");
        return { id: step.id, status: "verified", proof: `${step.target}:${mergeSha}` };
      },
      reverify: async ({ prior }) => prior,
      now: () => 200,
    });
    expect(first.status).toBe("blocked");
    expect(first.state.mergeSha).toBe(mergeSha);
    expect(first.state.phase).toBe("blocked");
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "blocked",
      mergeCommitSha: mergeSha,
      providerRelease: first.state,
    })).toBe(false);

    const executed: string[] = [];
    const reverified: string[] = [];
    const resumed = await runPostMergeReleaseBarrier(plan, first.state, mergeSha, {
      persist: async () => true,
      execute: async ({ step }) => {
        executed.push(step.id);
        return { id: step.id, status: "verified", proof: `${step.target}:${mergeSha}` };
      },
      reverify: async ({ step, prior }) => {
        reverified.push(step.id);
        return { ...prior, status: "verified" };
      },
      now: () => 300,
    });
    expect(resumed.status).toBe("live");
    expect(reverified).toEqual(plan.steps.filter((step) => step.phase === "postmerge").slice(0, 2).map((step) => step.id));
    expect(executed).toEqual(plan.steps.filter((step) => step.phase === "postmerge").slice(2).map((step) => step.id));
  });

  it("requires the exact merged SHA on the production alias and every provider before finalization", () => {
    const plan = jarvisPlan(["convex/schema.ts"]);
    const mergeSha = "d".repeat(40);
    const liveRelease: ProviderReleaseState = {
      releaseId: plan.releaseId,
      repository: plan.repository,
      branch: plan.branch,
      baseSha,
      headSha,
      mergeSha,
      changedPaths: [...plan.changedPaths],
      providers: [...plan.providers],
      impactDigest: plan.impactDigest,
      boundaryDigest: plan.boundaryDigest,
      phase: "live",
      attempts: 2,
      steps: plan.steps.map((step) => ({ id: step.id, status: "verified", proof: mergeSha })),
      updatedAt: 100,
    };
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "merged",
      deliveredHeadSha: "d".repeat(40),
      mergeCommitSha: mergeSha,
      providerRelease: liveRelease,
    })).toBe(false);
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "merged",
      deliveredHeadSha: headSha,
      mergeCommitSha: "e".repeat(40),
      providerRelease: liveRelease,
    })).toBe(false);
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "merged",
      deliveredHeadSha: headSha,
      mergeCommitSha: mergeSha,
      providerRelease: liveRelease,
    })).toBe(true);
  });

  it("rejects a READY Vercel deployment when the production alias or merged SHA differs", () => {
    const boundary = jarvisPlan(["convex/schema.ts"]).boundary!.vercel;
    const mergeSha = "d".repeat(40);
    const deployment = {
      uid: "dpl_exact123",
      projectId: "prj_exact123",
      target: "production",
      readyState: "READY",
      meta: { githubCommitSha: mergeSha },
    };
    const alias = {
      alias: boundary.productionAlias,
      deploymentId: deployment.uid,
      projectId: deployment.projectId,
    };
    expect(vercelLiveDeploymentMismatch({ boundary, expectedProjectId: deployment.projectId, mergeSha, deployment, alias })).toBeNull();
    expect(vercelLiveDeploymentMismatch({
      boundary,
      expectedProjectId: deployment.projectId,
      mergeSha: "e".repeat(40),
      deployment,
      alias,
    })).toContain("exact merged commit");
    expect(vercelLiveDeploymentMismatch({
      boundary,
      expectedProjectId: deployment.projectId,
      mergeSha,
      deployment,
      alias: { ...alias, alias: "preview.vercel.app" },
    })).toContain("production alias");
  });
});
