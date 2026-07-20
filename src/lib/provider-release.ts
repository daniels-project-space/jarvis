import { createHash } from "node:crypto";
import {
  PROJECT_REGISTRY,
  type ConvexReleaseTarget,
  type TrustedProviderBoundary,
} from "./project-registry";

export type ProviderKind = "convex" | "trigger";
export type ProviderReleasePhase = "deploying" | "ready" | "blocked";
export type ProviderStepStatus = "pending" | "deploying" | "verified" | "failed";

export type ProviderReleaseStep = Readonly<{
  id: string;
  kind: "vercel_identity" | ProviderKind;
  target: string;
  role?: "canonical" | "mirror";
}>;

export type ProviderStepReceipt = {
  id: string;
  status: ProviderStepStatus;
  proof?: string;
  version?: string;
  runId?: string;
  data?: Record<string, string | number | boolean>;
  checkedAt?: number;
};

export type ProviderReleasePlan = Readonly<{
  required: boolean;
  valid: boolean;
  note: string;
  releaseId: string;
  repository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  changedPaths: readonly string[];
  providers: readonly ProviderKind[];
  boundaryDigest: string;
  boundary?: TrustedProviderBoundary;
  steps: readonly ProviderReleaseStep[];
}>;

export type ProviderReleaseState = {
  releaseId: string;
  repository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  changedPaths: string[];
  providers: ProviderKind[];
  boundaryDigest: string;
  phase: ProviderReleasePhase;
  attempts: number;
  steps: ProviderStepReceipt[];
  note?: string;
  updatedAt: number;
};

export type ProviderBarrierResult =
  | { status: "not_required"; note: string }
  | { status: "ready"; note: string; headSha: string; state: ProviderReleaseState }
  | { status: "blocked"; note: string; state?: ProviderReleaseState };

type StepExecutionContext = {
  plan: ProviderReleasePlan;
  state: ProviderReleaseState;
  step: ProviderReleaseStep;
  prior: ProviderStepReceipt;
  checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>;
};

export type ProviderReleaseOperations = {
  persist: (state: ProviderReleaseState) => Promise<boolean>;
  execute: (context: StepExecutionContext) => Promise<ProviderStepReceipt>;
  reverify: (context: StepExecutionContext) => Promise<ProviderStepReceipt>;
  now?: () => number;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedRepo(repo: string): string {
  return repo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
}

function normalizedPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replaceAll("\\", "/");
}

export function providerKindsForPaths(paths: readonly string[]): ProviderKind[] {
  const kinds = new Set<ProviderKind>();
  for (const rawPath of paths) {
    const path = normalizedPath(rawPath);
    if (!path || path.startsWith("../") || path.includes("/../")) continue;
    if (path === "convex.json" || path.startsWith("convex/")) kinds.add("convex");
    if (
      /^trigger\.config\.(?:ts|js|mjs|cjs)$/.test(path)
      || path.startsWith("src/trigger/")
    ) kinds.add("trigger");
  }
  return (["convex", "trigger"] as const).filter((kind) => kinds.has(kind));
}

function convexStep(target: ConvexReleaseTarget): ProviderReleaseStep {
  return {
    id: `convex:${target.role}:${target.deployment}`,
    kind: "convex",
    target: target.deployment,
    role: target.role,
  };
}

function validateBoundary(
  repo: string,
  providers: readonly ProviderKind[],
  boundary: TrustedProviderBoundary | undefined,
): string | null {
  if (!boundary) return `provider-sensitive paths changed in ${repo}, but its exact trusted release boundary is missing`;
  if (normalizedRepo(boundary.vercel.gitRepository) !== normalizedRepo(repo)) {
    return `Vercel Git binding mismatch: ${boundary.vercel.gitRepository} is not ${repo}`;
  }
  if (!boundary.vercel.teamId || !boundary.vercel.projectName || !boundary.vercel.productionAlias || !boundary.vercel.productionBranch) {
    return "the Vercel project identity is incomplete";
  }
  if (providers.includes("convex")) {
    const targets = boundary.convex?.targets ?? [];
    const canonical = targets.filter((target) => target.role === "canonical");
    if (canonical.length !== 1) return "the exact canonical Convex release target is missing or ambiguous";
    const names = new Set<string>();
    for (const target of targets) {
      let hostname = "";
      try {
        hostname = new URL(target.url).hostname;
      } catch {
        return `Convex target ${target.deployment} has an invalid URL`;
      }
      if (hostname !== `${target.deployment}.convex.cloud` || names.has(target.deployment)) {
        return `Convex target identity ${target.deployment} is mismatched or duplicated`;
      }
      names.add(target.deployment);
    }
  }
  if (providers.includes("trigger") && !boundary.trigger?.projectRef) {
    return "the exact Trigger.dev project identity is missing";
  }
  return null;
}

export function buildProviderReleasePlan(input: {
  repository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  changedPaths: readonly string[];
}): ProviderReleasePlan {
  const repository = normalizedRepo(input.repository);
  const changedPaths = [...new Set(input.changedPaths.map(normalizedPath).filter(Boolean))].sort();
  const providers = providerKindsForPaths(changedPaths);
  const project = PROJECT_REGISTRY.find((candidate) => normalizedRepo(candidate.repo) === repository);
  const boundary = project?.providerBoundary?.release;
  const boundaryDigest = boundary ? sha256(stableJson(boundary)) : "missing";
  const releaseId = `providers-v1:${sha256(stableJson({
    repository,
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths,
    providers,
    boundaryDigest,
  }))}`;
  if (!providers.length) {
    return {
      required: false,
      valid: true,
      note: "no provider-sensitive paths changed",
      releaseId,
      repository,
      branch: input.branch,
      baseSha: input.baseSha,
      headSha: input.headSha,
      changedPaths,
      providers,
      boundaryDigest,
      boundary,
      steps: [],
    };
  }
  const invalid = validateBoundary(repository, providers, boundary);
  const steps: ProviderReleaseStep[] = boundary
    ? [
        {
          id: `vercel:${boundary.vercel.teamId}:${boundary.vercel.projectName}`,
          kind: "vercel_identity",
          target: `${boundary.vercel.teamId}/${boundary.vercel.projectName}`,
        },
        ...(providers.includes("convex") ? (boundary.convex?.targets ?? []).map(convexStep) : []),
        ...(providers.includes("trigger") && boundary.trigger
          ? [{ id: `trigger:${boundary.trigger.projectRef}`, kind: "trigger" as const, target: boundary.trigger.projectRef }]
          : []),
      ]
    : [];
  return {
    required: true,
    valid: !invalid,
    note: invalid ?? `trusted prerequisites required for ${providers.join(" and ")}`,
    releaseId,
    repository,
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths,
    providers,
    boundaryDigest,
    boundary,
    steps,
  };
}

function initialState(
  plan: ProviderReleasePlan,
  prior: ProviderReleaseState | undefined,
  now: number,
): ProviderReleaseState {
  const reusable = prior
    && prior.releaseId === plan.releaseId
    && prior.headSha === plan.headSha
    && prior.boundaryDigest === plan.boundaryDigest;
  const priorById = new Map((reusable ? prior.steps : []).map((receipt) => [receipt.id, receipt]));
  return {
    releaseId: plan.releaseId,
    repository: plan.repository,
    branch: plan.branch,
    baseSha: plan.baseSha,
    headSha: plan.headSha,
    changedPaths: [...plan.changedPaths],
    providers: [...plan.providers],
    boundaryDigest: plan.boundaryDigest,
    phase: "deploying",
    attempts: reusable ? Math.max(1, Number(prior.attempts ?? 1)) + 1 : 1,
    steps: plan.steps.map((step) => priorById.get(step.id) ?? { id: step.id, status: "pending" }),
    note: reusable ? "resuming the trusted provider release phase" : "trusted provider release phase started",
    updatedAt: now,
  };
}

export async function runProviderReleaseBarrier(
  plan: ProviderReleasePlan,
  prior: ProviderReleaseState | undefined,
  operations: ProviderReleaseOperations,
): Promise<ProviderBarrierResult> {
  if (!plan.required) return { status: "not_required", note: plan.note };
  if (!plan.valid) return { status: "blocked", note: plan.note };
  const now = operations.now ?? Date.now;
  const state = initialState(plan, prior, now());
  if (!(await operations.persist(state))) {
    return { status: "blocked", note: "the durable provider release phase could not be entered", state };
  }

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    let receipt = state.steps[index];
    const checkpoint = async (next: ProviderStepReceipt): Promise<boolean> => {
      if (next.id !== step.id) return false;
      state.steps[index] = { ...next, checkedAt: next.checkedAt ?? now() };
      state.updatedAt = now();
      state.note = `${step.kind} ${step.target}: ${next.status}`;
      return await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) });
    };

    try {
      if (receipt.status === "verified") {
        receipt = await operations.reverify({ plan, state, step, prior: receipt, checkpoint });
        if (!(await checkpoint(receipt))) {
          throw new Error(`could not persist re-verification for ${step.id}`);
        }
      }
      if (receipt.status !== "verified") {
        receipt = await operations.execute({ plan, state, step, prior: receipt, checkpoint });
        if (!(await checkpoint(receipt))) {
          throw new Error(`could not persist provider receipt for ${step.id}`);
        }
      }
      if (receipt.status !== "verified") throw new Error(receipt.proof || `${step.id} was not independently verified`);
    } catch (error) {
      const note = String(error instanceof Error ? error.message : error).slice(0, 800);
      state.phase = "blocked";
      state.note = note;
      state.updatedAt = now();
      state.steps[index] = { ...receipt, id: step.id, status: "failed", proof: note, checkedAt: now() };
      await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) });
      return { status: "blocked", note, state };
    }
  }

  state.phase = "ready";
  state.note = "all exact provider prerequisites independently verified";
  state.updatedAt = now();
  if (!(await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) }))) {
    return { status: "blocked", note: "provider prerequisites passed, but the durable ready barrier could not be recorded", state };
  }
  return { status: "ready", note: state.note, headSha: plan.headSha, state };
}

