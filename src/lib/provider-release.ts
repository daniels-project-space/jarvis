import { createHash } from "node:crypto";
import { dirname, extname, posix } from "node:path";
import {
  PROJECT_REGISTRY,
  type ConvexReleaseTarget,
  type TrustedProviderBoundary,
} from "./project-registry";

export type ProviderKind = "convex" | "trigger";
export type ProviderReleasePhase =
  | "deploying"
  | "premerge_ready"
  | "verifying_live"
  | "live"
  | "blocked";
export type ProviderStepStatus = "pending" | "deploying" | "verified" | "failed";
export type ProviderStepPhase = "premerge" | "postmerge";

export type ProviderReleaseStep = Readonly<{
  id: string;
  phase: ProviderStepPhase;
  kind: "vercel_identity" | "vercel_live" | ProviderKind;
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

export type ProviderImpact = Readonly<{
  providers: readonly ProviderKind[];
  reasons: Readonly<Record<ProviderKind, readonly string[]>>;
  digest: string;
}>;

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
  impactDigest: string;
  impactReasons: Readonly<Record<ProviderKind, readonly string[]>>;
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
  mergeSha?: string;
  changedPaths: string[];
  providers: ProviderKind[];
  impactDigest: string;
  boundaryDigest: string;
  phase: ProviderReleasePhase;
  attempts: number;
  steps: ProviderStepReceipt[];
  note?: string;
  updatedAt: number;
};

export type ProviderBarrierResult =
  | { status: "not_required"; note: string }
  | { status: "ready"; note: string; headSha: string; baseSha: string; state: ProviderReleaseState }
  | { status: "blocked"; note: string; state?: ProviderReleaseState };

export type ProviderLiveBarrierResult =
  | { status: "live"; note: string; mergeSha: string; state: ProviderReleaseState }
  | { status: "blocked"; note: string; state: ProviderReleaseState };

export type VercelProjectObservation = {
  id?: string;
  name?: string;
  accountId?: string;
  link?: { type?: string; org?: string; repo?: string; productionBranch?: string };
  targets?: { production?: { alias?: string[] } };
  alias?: Array<string | { domain?: string }>;
};

export type VercelDeploymentObservation = {
  uid?: string;
  id?: string;
  projectId?: string;
  target?: string;
  state?: string;
  readyState?: string;
  readySubstate?: string;
  aliasAssigned?: boolean | number;
  alias?: string[];
  meta?: Record<string, unknown> | string;
};

export type VercelAliasObservation = {
  alias?: string;
  deploymentId?: string;
  projectId?: string;
  deployment?: { id?: string; url?: string; meta?: Record<string, unknown> | string };
};

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

const SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json",
  ".css", ".scss", ".sass", ".less", ".graphql", ".gql", ".sql", ".wasm",
];
const GLOBAL_PROVIDER_INPUT = /^(?:(?:[^/]+\/)*(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|\.npmrc|\.node-version|\.nvmrc|\.tool-versions|tsconfig(?:\.[^/]+)?\.json|vercel\.json|[^/]+\.config\.[cm]?[jt]s)$/i;
const SOURCE_LIKE = /\.(?:[cm]?[jt]sx?|json)$/i;
const IMPORT_SPECIFIER = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/g;
const RUNTIME_FILE_SPECIFIER = /\b(?:new\s+URL|readFile(?:Sync)?|readFile)\s*\(\s*["']([^"']+)["']/g;

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

function normalizedDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").split("/")[0].replace(/\.$/, "").toLowerCase();
}

function normalizedPath(path: string): string {
  return posix.normalize(path.trim().replace(/^\.\//, "").replaceAll("\\", "/")).replace(/^\.\//, "");
}

function orderedKinds(kinds: ReadonlySet<ProviderKind>): ProviderKind[] {
  return (["convex", "trigger"] as const).filter((kind) => kinds.has(kind));
}

/** Validate the live Vercel lookup before its Git integration can be trusted. */
export function vercelProjectIdentityMismatch(
  boundary: TrustedProviderBoundary["vercel"],
  project: VercelProjectObservation,
): string | null {
  if (!/^prj_[a-z0-9]+$/i.test(String(project.id ?? ""))) {
    return "Vercel did not return a stable project id";
  }
  if (project.name !== boundary.projectName || project.accountId !== boundary.teamId) {
    return "Vercel returned a project outside the registered team/name identity";
  }
  if (boundary.projectId && project.id !== boundary.projectId) {
    return "Vercel returned the wrong stable project id";
  }
  const linkedRepo = `${String(project.link?.org ?? "")}/${String(project.link?.repo ?? "")}`;
  if (
    project.link?.type !== "github"
    || normalizedRepo(linkedRepo) !== normalizedRepo(boundary.gitRepository)
    || project.link?.productionBranch !== boundary.productionBranch
  ) {
    return "Vercel Git repository or production branch does not match the trusted registry";
  }
  const aliases = [
    ...(project.targets?.production?.alias ?? []),
    ...((project.alias ?? []).map((entry) => typeof entry === "string" ? entry : String(entry.domain ?? ""))),
  ].map(normalizedDomain);
  if (!aliases.includes(normalizedDomain(boundary.productionAlias))) {
    return `Vercel production alias ${boundary.productionAlias} was not independently observed`;
  }
  return null;
}

/** Validate both the immutable deployment and the alias currently routing to it. */
export function vercelLiveDeploymentMismatch(input: {
  boundary: TrustedProviderBoundary["vercel"];
  expectedProjectId: string;
  mergeSha: string;
  deployment: VercelDeploymentObservation;
  alias: VercelAliasObservation;
}): string | null {
  const deploymentId = String(input.deployment.uid ?? input.deployment.id ?? "");
  if (!/^dpl_[a-z0-9]+$/i.test(deploymentId)) return "Vercel did not return an immutable deployment id";
  if (
    input.deployment.projectId !== input.expectedProjectId
    || input.alias.projectId !== input.expectedProjectId
    || (input.boundary.projectId && input.expectedProjectId !== input.boundary.projectId)
  ) return "Vercel deployment or alias belongs to the wrong project";
  if (input.deployment.target !== "production" || (input.deployment.readyState ?? input.deployment.state) !== "READY") {
    return "Vercel production deployment is not READY";
  }
  const meta = typeof input.deployment.meta === "object" && input.deployment.meta ? input.deployment.meta : {};
  const observedSha = String(meta.githubCommitSha ?? meta.gitCommitSha ?? meta.commitSha ?? "");
  if (observedSha !== input.mergeSha) return "Vercel deployment does not identify the exact merged commit";
  if (
    normalizedDomain(String(input.alias.alias ?? "")) !== normalizedDomain(input.boundary.productionAlias)
    || String(input.alias.deploymentId ?? input.alias.deployment?.id ?? "") !== deploymentId
  ) return "Vercel production alias is not routing to the exact merged deployment";
  return null;
}

function globalInputProviders(path: string): ProviderKind[] {
  if (GLOBAL_PROVIDER_INPUT.test(path) || path.startsWith("scripts/")) return ["convex", "trigger"];
  if (path === "convex.json" || path === "convex/tsconfig.json" || path.startsWith("convex/")) return ["convex"];
  if (/^trigger\.config\.(?:ts|js|mjs|cjs)$/.test(path) || path.startsWith("src/trigger/")) return ["trigger"];
  return [];
}

/**
 * Cheap fail-closed fallback for callers that cannot supply an exact source
 * snapshot. Shared/build inputs are intentionally over-classified.
 */
export function providerKindsForPaths(paths: readonly string[]): ProviderKind[] {
  const kinds = new Set<ProviderKind>();
  for (const rawPath of paths) {
    const path = normalizedPath(rawPath);
    if (!path || path === ".." || path.startsWith("../") || path.includes("/../")) continue;
    for (const kind of globalInputProviders(path)) kinds.add(kind);
    if (/^(?:src\/(?:lib|shared)|lib|shared)\//.test(path)) {
      kinds.add("convex");
      kinds.add("trigger");
    }
  }
  return orderedKinds(kinds);
}

function resolveLocalImports(from: string, specifier: string, sources: ReadonlyMap<string, string>): string[] {
  let candidate: string;
  if (specifier.startsWith(".")) candidate = normalizedPath(posix.join(dirname(from), specifier));
  else if (specifier.startsWith("@/")) candidate = normalizedPath(`src/${specifier.slice(2)}`);
  else if (specifier.startsWith("~/")) candidate = normalizedPath(`src/${specifier.slice(2)}`);
  else return [];
  const explicit = extname(candidate)
    ? [candidate]
    : [candidate, ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => `${candidate}/index${extension}`)];
  const candidates = new Set(explicit);
  if (!extname(candidate)) {
    for (const path of sources.keys()) {
      if (path.startsWith(`${candidate}.`) || path.startsWith(`${candidate}/index.`)) candidates.add(path);
    }
  }
  return [...candidates].filter((path) => sources.has(path));
}

function importsFor(path: string, source: string, sources: ReadonlyMap<string, string>): string[] {
  const imports = new Set<string>();
  for (const pattern of [IMPORT_SPECIFIER, RUNTIME_FILE_SPECIFIER]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      for (const resolved of resolveLocalImports(path, match[1], sources)) imports.add(resolved);
    }
  }
  return [...imports];
}

function reachableFrom(roots: readonly string[], graph: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    for (const dependency of graph.get(path) ?? []) pending.push(dependency);
  }
  return reachable;
}

/**
 * Build the provider import closures from the exact candidate tree. A shared
 * module is provider-sensitive when any Convex function or Trigger task/config
 * reaches it transitively. Missing/deleted shared source fails closed.
 */
export function analyseProviderImpact(
  changedPathsInput: readonly string[],
  sourceInput: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): ProviderImpact {
  const sources = sourceInput instanceof Map
    ? new Map([...sourceInput].map(([path, source]) => [normalizedPath(path), source]))
    : new Map(Object.entries(sourceInput).map(([path, source]) => [normalizedPath(path), source]));
  const changedPaths = [...new Set(changedPathsInput.map(normalizedPath).filter(Boolean))].sort();
  const graph = new Map<string, readonly string[]>();
  for (const [path, source] of sources) {
    if (SOURCE_LIKE.test(path)) graph.set(path, importsFor(path, source, sources));
  }
  const convexReachable = reachableFrom(
    [...sources.keys()].filter((path) => path.startsWith("convex/") && SOURCE_LIKE.test(path)),
    graph,
  );
  const triggerReachable = reachableFrom(
    [...sources.keys()].filter((path) => (path.startsWith("src/trigger/") || /^trigger\.config\./.test(path)) && SOURCE_LIKE.test(path)),
    graph,
  );
  const reasons: Record<ProviderKind, string[]> = { convex: [], trigger: [] };
  const add = (kind: ProviderKind, reason: string) => {
    if (!reasons[kind].includes(reason)) reasons[kind].push(reason);
  };
  for (const path of changedPaths) {
    for (const kind of globalInputProviders(path)) add(kind, `${path}: provider build/runtime input`);
    if (convexReachable.has(path)) add("convex", `${path}: transitively imported by Convex`);
    if (triggerReachable.has(path)) add("trigger", `${path}: transitively imported by Trigger`);
    if (!sources.has(path) && SOURCE_LIKE.test(path) && /^(?:src|lib|shared)\//.test(path)) {
      add("convex", `${path}: deleted or unavailable shared source`);
      add("trigger", `${path}: deleted or unavailable shared source`);
    }
  }
  const kinds = new Set<ProviderKind>();
  if (reasons.convex.length) kinds.add("convex");
  if (reasons.trigger.length) kinds.add("trigger");
  const providers = orderedKinds(kinds);
  const normalizedReasons = {
    convex: [...reasons.convex].sort(),
    trigger: [...reasons.trigger].sort(),
  };
  return {
    providers,
    reasons: normalizedReasons,
    digest: sha256(stableJson({ changedPaths, providers, reasons: normalizedReasons })),
  };
}

function convexStep(target: ConvexReleaseTarget, phase: ProviderStepPhase): ProviderReleaseStep {
  return {
    id: `${phase === "postmerge" ? "live:" : ""}convex:${target.role}:${target.deployment}`,
    phase,
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
  if (boundary.r2 && !boundary.r2.bucket.trim()) return "the R2 artifact boundary is incomplete";
  return null;
}

export function buildProviderReleasePlan(input: {
  repository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  changedPaths: readonly string[];
  sources?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  impact?: ProviderImpact;
}): ProviderReleasePlan {
  const repository = normalizedRepo(input.repository);
  const changedPaths = [...new Set(input.changedPaths.map(normalizedPath).filter(Boolean))].sort();
  const impact = input.impact ?? (input.sources
    ? analyseProviderImpact(changedPaths, input.sources)
    : (() => {
        const providers = providerKindsForPaths(changedPaths);
        const reasons = {
          convex: providers.includes("convex") ? ["conservative path-only classification"] : [],
          trigger: providers.includes("trigger") ? ["conservative path-only classification"] : [],
        };
        return { providers, reasons, digest: sha256(stableJson({ changedPaths, providers, reasons })) };
      })());
  const providers = [...impact.providers];
  const project = PROJECT_REGISTRY.find((candidate) => normalizedRepo(candidate.repo) === repository);
  const boundary = project?.providerBoundary?.release;
  const boundaryDigest = boundary ? sha256(stableJson(boundary)) : "missing";
  const releaseId = `providers-v2:${sha256(stableJson({
    repository,
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths,
    providers,
    impactDigest: impact.digest,
    boundaryDigest,
  }))}`;
  if (!providers.length) {
    return {
      required: false,
      valid: true,
      note: "no provider bundle or build/runtime input is affected",
      releaseId,
      repository,
      branch: input.branch,
      baseSha: input.baseSha,
      headSha: input.headSha,
      changedPaths,
      providers,
      impactDigest: impact.digest,
      impactReasons: impact.reasons,
      boundaryDigest,
      boundary,
      steps: [],
    };
  }
  const invalid = validateBoundary(repository, providers, boundary);
  const premerge: ProviderReleaseStep[] = boundary
    ? [
        {
          id: `vercel:${boundary.vercel.teamId}:${boundary.vercel.projectName}`,
          phase: "premerge",
          kind: "vercel_identity",
          target: `${boundary.vercel.teamId}/${boundary.vercel.projectName}`,
        },
        ...(providers.includes("convex") ? (boundary.convex?.targets ?? []).map((target) => convexStep(target, "premerge")) : []),
        ...(providers.includes("trigger") && boundary.trigger
          ? [{ id: `trigger:${boundary.trigger.projectRef}`, phase: "premerge" as const, kind: "trigger" as const, target: boundary.trigger.projectRef }]
          : []),
      ]
    : [];
  const postmerge: ProviderReleaseStep[] = boundary
    ? [
        {
          id: `live:vercel:${boundary.vercel.productionAlias}`,
          phase: "postmerge",
          kind: "vercel_live",
          target: boundary.vercel.productionAlias,
        },
        ...(providers.includes("convex") ? (boundary.convex?.targets ?? []).map((target) => convexStep(target, "postmerge")) : []),
        ...(providers.includes("trigger") && boundary.trigger
          ? [{ id: `live:trigger:${boundary.trigger.projectRef}`, phase: "postmerge" as const, kind: "trigger" as const, target: boundary.trigger.projectRef }]
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
    impactDigest: impact.digest,
    impactReasons: impact.reasons,
    boundaryDigest,
    boundary,
    steps: [...premerge, ...postmerge],
  };
}

function initialState(plan: ProviderReleasePlan, prior: ProviderReleaseState | undefined, now: number): ProviderReleaseState {
  const reusable = prior
    && prior.releaseId === plan.releaseId
    && prior.baseSha === plan.baseSha
    && prior.headSha === plan.headSha
    && prior.impactDigest === plan.impactDigest
    && prior.boundaryDigest === plan.boundaryDigest;
  const priorById = new Map((reusable ? prior.steps : []).map((receipt) => [receipt.id, receipt]));
  return {
    releaseId: plan.releaseId,
    repository: plan.repository,
    branch: plan.branch,
    baseSha: plan.baseSha,
    headSha: plan.headSha,
    mergeSha: reusable ? prior.mergeSha : undefined,
    changedPaths: [...plan.changedPaths],
    providers: [...plan.providers],
    impactDigest: plan.impactDigest,
    boundaryDigest: plan.boundaryDigest,
    phase: "deploying",
    attempts: reusable ? Math.max(1, Number(prior.attempts ?? 1)) + 1 : 1,
    steps: plan.steps.map((step) => priorById.get(step.id) ?? { id: step.id, status: "pending" }),
    note: reusable ? "resuming the trusted provider release phase" : "trusted provider release phase started",
    updatedAt: now,
  };
}

async function runSteps(input: {
  plan: ProviderReleasePlan;
  state: ProviderReleaseState;
  operations: ProviderReleaseOperations;
  phase: ProviderStepPhase;
}): Promise<{ ok: true } | { ok: false; note: string }> {
  const now = input.operations.now ?? Date.now;
  for (const step of input.plan.steps.filter((candidate) => candidate.phase === input.phase)) {
    const index = input.plan.steps.findIndex((candidate) => candidate.id === step.id);
    let receipt = input.state.steps[index];
    const checkpoint = async (next: ProviderStepReceipt): Promise<boolean> => {
      if (next.id !== step.id) return false;
      input.state.steps[index] = { ...next, checkedAt: next.checkedAt ?? now() };
      input.state.updatedAt = now();
      input.state.note = `${step.kind} ${step.target}: ${next.status}`;
      return await input.operations.persist({ ...input.state, steps: input.state.steps.map((item) => ({ ...item })) });
    };
    try {
      if (receipt.status === "verified") {
        receipt = await input.operations.reverify({ plan: input.plan, state: input.state, step, prior: receipt, checkpoint });
        if (!(await checkpoint(receipt))) throw new Error(`could not persist re-verification for ${step.id}`);
      }
      if (receipt.status !== "verified") {
        receipt = await input.operations.execute({ plan: input.plan, state: input.state, step, prior: receipt, checkpoint });
        if (!(await checkpoint(receipt))) throw new Error(`could not persist provider receipt for ${step.id}`);
      }
      if (receipt.status !== "verified") throw new Error(receipt.proof || `${step.id} was not independently verified`);
    } catch (error) {
      const note = String(error instanceof Error ? error.message : error).slice(0, 800);
      input.state.phase = "blocked";
      input.state.note = note;
      input.state.updatedAt = now();
      input.state.steps[index] = {
        ...input.state.steps[index],
        id: step.id,
        status: "failed",
        proof: note,
        checkedAt: now(),
      };
      await input.operations.persist({ ...input.state, steps: input.state.steps.map((item) => ({ ...item })) });
      return { ok: false, note };
    }
  }
  return { ok: true };
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
  const result = await runSteps({ plan, state, operations, phase: "premerge" });
  if (!result.ok) return { status: "blocked", note: result.note, state };
  state.phase = "premerge_ready";
  state.note = "all exact pre-merge provider prerequisites independently verified";
  state.updatedAt = now();
  if (!(await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) }))) {
    return { status: "blocked", note: "provider prerequisites passed, but the durable pre-merge barrier could not be recorded", state };
  }
  return { status: "ready", note: state.note, headSha: plan.headSha, baseSha: plan.baseSha, state };
}

export async function runPostMergeReleaseBarrier(
  plan: ProviderReleasePlan,
  prior: ProviderReleaseState,
  mergeSha: string,
  operations: ProviderReleaseOperations,
): Promise<ProviderLiveBarrierResult> {
  const now = operations.now ?? Date.now;
  const state = initialState(plan, prior, now());
  if (!/^[0-9a-f]{40,64}$/i.test(mergeSha)) {
    return { status: "blocked", note: "GitHub did not return an exact post-merge commit", state };
  }
  if (state.mergeSha && state.mergeSha !== mergeSha) {
    return { status: "blocked", note: "the resumed post-merge commit differs from the durable release", state };
  }
  const premergeIds = new Set(plan.steps.filter((step) => step.phase === "premerge").map((step) => step.id));
  if (state.steps.some((receipt) => premergeIds.has(receipt.id) && receipt.status !== "verified")) {
    return { status: "blocked", note: "post-merge verification cannot start without exact pre-merge evidence", state };
  }
  state.mergeSha = mergeSha;
  state.phase = "verifying_live";
  state.note = `verifying exact merged commit ${mergeSha} on every production provider`;
  state.updatedAt = now();
  if (!(await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) }))) {
    return { status: "blocked", note: "the durable post-merge provider phase could not be entered", state };
  }
  const result = await runSteps({ plan, state, operations, phase: "postmerge" });
  if (!result.ok) return { status: "blocked", note: result.note, state };
  state.phase = "live";
  state.note = `exact merged commit ${mergeSha} is live on Vercel and every impacted provider`;
  state.updatedAt = now();
  if (!(await operations.persist({ ...state, steps: state.steps.map((item) => ({ ...item })) }))) {
    return { status: "blocked", note: "live provider proofs passed, but their durable barrier could not be recorded", state };
  }
  return { status: "live", note: state.note, mergeSha, state };
}
