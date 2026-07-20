import { describe, expect, it, vi } from "vitest";
import { verifiedDeliveryCanFinalize } from "./provider-release-finalization";
import {
  buildProviderReleasePlan,
  providerKindsForPaths,
  runProviderReleaseBarrier,
  vercelProjectIdentityMismatch,
  type ProviderReleaseState,
  type ProviderStepReceipt,
} from "./provider-release";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function jarvisPlan(paths: string[]) {
  return buildProviderReleasePlan({
    repository: "daniels-project-space/jarvis",
    branch: "jarvis/paul-provider-order",
    baseSha,
    headSha,
    changedPaths: paths,
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

  it("orders Jarvis's exact project-isolated prerequisites before web delivery", () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
    expect(plan).toMatchObject({ required: true, valid: true });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "vercel:team_VY2PwHgXLV9Bo0vs2iXdnGxw:jarvis",
      "convex:canonical:tangible-goose-318",
      "convex:mirror:scintillating-camel-329",
      "trigger:proj_wjwbdgeipgpddvrazxnp",
    ]);
    expect(plan.boundary?.vercel).toMatchObject({
      productionAlias: "jarvis-orcin-six.vercel.app",
      productionBranch: "main",
      gitRepository: "daniels-project-space/jarvis",
    });
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
    expect(result).toEqual({ status: "not_required", note: "no provider-sensitive paths changed" });
    expect(persist).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("durable two-phase provider barrier", () => {
  it("persists deployment phase before exact prerequisites execute in safe order", async () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
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
    expect(events[0]).toBe("persist:deploying:pending,pending,pending,pending");
    expect(events.filter((event) => event.startsWith("execute:"))).toEqual(
      plan.steps.map((step) => `execute:${step.id}`),
    );
    expect(events.at(-1)).toContain("persist:ready:");
  });

  it("fences merge/finalization on provider failure and resumes receipts without implementation", async () => {
    const plan = jarvisPlan(["convex/schema.ts", "src/trigger/agent-runner.ts"]);
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
    expect(executed).toEqual(plan.steps.slice(2).map((step) => step.id));
    expect(resumed.status === "ready" && resumed.state.attempts).toBe(2);
  });

  it("preserves a staged provider handoff when a later operation fails", async () => {
    const plan = jarvisPlan(["src/trigger/agent-runner.ts"]);
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
    expect(blocked?.steps.at(-1)).toMatchObject({
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

  it("rejects a stale or mismatched release receipt at finalization", () => {
    const readyRelease: ProviderReleaseState = {
      releaseId: `providers-v1:${"c".repeat(64)}`,
      repository: "daniels-project-space/jarvis",
      branch: "jarvis/paul-provider-order",
      baseSha,
      headSha,
      changedPaths: ["convex/schema.ts"],
      providers: ["convex"],
      boundaryDigest: "digest",
      phase: "ready",
      attempts: 1,
      steps: [{ id: "convex:canonical:tangible-goose-318", status: "verified" }],
      updatedAt: 100,
    };
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "merged",
      deliveredHeadSha: "d".repeat(40),
      providerRelease: readyRelease,
    })).toBe(false);
    expect(verifiedDeliveryCanFinalize({
      verificationVerdict: "pass",
      deliveryStatus: "merged",
      deliveredHeadSha: headSha,
      providerRelease: readyRelease,
    })).toBe(true);
  });
});
