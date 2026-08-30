import { PROJECT_REGISTRY, projectProviderBoundary } from "./project-registry";
import { selectCodexWorkPolicy, type CodexWorkSelection } from "./codex-work-router";
import { EVIDENCE_INTEGRITY_RULES } from "./work-verification";
import { SAFE_SANDBOX_EXECUTION_RULES } from "./work-safety";
import { canonicalizeRepository } from "./workflow-contract";
import { validateWorkDag } from "./workspace-protocol";

export const GOAL_PLAN_MARKER = "GOAL_PLAN_JSON:";
export const GOAL_VALIDATION_MARKER = "GOAL_VALIDATION_JSON:";
export const GOAL_PLAN_RESULT_MAX_CHARS = 8_000;
export const GOAL_VALIDATOR_TASK_MAX_CHARS = 40_000;

// A model segment is already 15 minutes for Luna/Terra and 25 minutes for Sol.
// These are automatic continuation budgets, not total mission limits: every
// segment checkpoints durably, and an explicit resume can extend the affected
// leaf after Daniel fixes an external blocker or deliberately grants more time.
export const GOAL_AUTOMATIC_ATTEMPT_LIMITS = {
  planning: 3,
  building: 4,
  validating: 3,
  refining: 3,
} as const;

export const GOAL_ROUTE_KINDS = [
  "app_factory",
  "youtube_studio",
  "existing_project",
  "cloud_new",
  "general",
] as const;

export type GoalRouteKind = (typeof GOAL_ROUTE_KINDS)[number];
export type GoalReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type GoalAgentId = "jarvis" | "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";

export const GOAL_DELIVERABLE_KINDS = [
  "code_change",
  "research_brief",
  "creative_artifact",
  "operational_result",
  "decision_brief",
] as const;

export type GoalDeliverableKind = (typeof GOAL_DELIVERABLE_KINDS)[number];

export type GoalOutcomeContract = {
  objective: string;
  metric: string;
  baseline: string;
  target: string;
  measurementWindow: string;
  evidenceSources: string[];
  stopConditions: string[];
};

export type GoalCrewCharter = {
  process: "hierarchical";
  manager: "jarvis";
  delegationRules: string[];
  humanEscalation: string[];
  reportingCadence: string;
};

export type GoalWorkstreamDeliverable = {
  kind: GoalDeliverableKind;
  description: string;
  requiredEvidence: string[];
};

export type GoalRoute = {
  kind: GoalRouteKind;
  primaryRepo?: string;
  project?: string;
  reason: string;
  infrastructureContext: string;
};

export type GoalWorkstream = {
  id: string;
  label: string;
  task: string;
  agentId: Exclude<GoalAgentId, "jarvis">;
  repo?: string;
  readonly: boolean;
  dependsOn: string[];
  acceptanceCriteria: string[];
  deliverable: GoalWorkstreamDeliverable;
  guardrails: string[];
  mcp: Array<"playwright" | "context7">;
};

/**
 * Keep Goal Mode's final quality gate strong without spending Terra/Sol on a
 * mechanically bounded evidence read. Writable, production, root-cause,
 * media-generation and broad-tool nodes retain the adaptive router's
 * Terra/Sol floor. Luna remains available only when the owner explicitly asks
 * for low latency and the node is bounded, read-only, and low risk.
 */
export function selectGoalWorkstreamPolicy(
  workstream: Pick<GoalWorkstream, "task" | "agentId" | "repo" | "readonly" | "mcp">,
): CodexWorkSelection {
  const input = {
    task: workstream.task,
    role: workstream.agentId,
    repo: workstream.repo,
    readonly: workstream.readonly,
    risk: workstream.readonly ? "low" : "high",
    tools: workstream.mcp,
  } as const;
  const selected = selectCodexWorkPolicy(input);
  const boundedReadOnlyEvidence = workstream.readonly
    && selected.complexity === "bounded"
    && selected.productionRisk === "low"
    && selected.toolBreadth !== "broad"
    && (selected.workType === "research" || selected.workType === "verification");
  return boundedReadOnlyEvidence || selected.model !== "luna"
    ? selected
    : selectCodexWorkPolicy({ ...input, requestedModel: "terra" });
}

export type GoalPlan = {
  summary: string;
  route: GoalRouteKind;
  primaryRepo?: string;
  assumptions: string[];
  outcome: GoalOutcomeContract;
  crew: GoalCrewCharter;
  workstreams: GoalWorkstream[];
  validation: {
    criteria: string[];
    tests: string[];
    liveChecks: string[];
  };
  factory?: {
    name: string;
    slug: string;
    brief: string;
  };
};

export type GoalRefinement = {
  id: string;
  label: string;
  task: string;
  acceptanceCriteria: string[];
};

export type GoalValidation = {
  verdict: "pass" | "refine" | "blocked";
  summary: string;
  evidence: string[];
  outcomeAchieved: boolean;
  outcomeEvidence: string[];
  stopConditionsSatisfied: string[];
  observedOutcome?: {
    metric: string;
    baseline: string;
    observed: string;
    target: string;
    measurementWindow: string;
  };
  gaps: string[];
  refinements: GoalRefinement[];
  blocker?: string;
};

export type GoalPhaseJob = {
  _id?: unknown;
  status?: string;
  label?: string;
  task?: string;
  goalStage?: string;
  goalWave?: number;
  nextRunAt?: number;
  approvalRequired?: boolean;
  approvalStatus?: string;
  dependsOn?: string[];
};

export type GoalMissionLease = {
  mode?: string;
  status?: string;
  phase?: string;
  revisionWave?: number;
};

export function summarizeGoalPhase(jobs: GoalPhaseJob[]) {
  // `needs_input` is a terminal attempt state, not proof that the whole
  // outcome needs Daniel. Goal Mode's recovery controller decides whether it
  // is an automatic retry or a genuine protected gate.
  const failed = jobs.filter((job) => job.status === "error" || job.status === "cancelled" || job.status === "needs_input");
  return {
    state: jobs.length === 0
      ? "empty" as const
      : failed.length > 0
        ? "blocked" as const
        : jobs.every((job) => job.status === "done")
          ? "complete" as const
          : "active" as const,
    failed,
  };
}

export function goalJobMatchesMissionPhase(job: GoalPhaseJob, mission: GoalMissionLease): boolean {
  if (mission.mode !== "goal") return true;
  if (mission.status !== "running") return false;
  const expectedStage = mission.phase === "planning"
    ? "planning"
    : mission.phase === "building"
      ? "building"
      : mission.phase === "refining"
        ? "refining"
        : mission.phase === "validating"
          ? "validating"
          : null;
  if (!expectedStage || job.goalStage !== expectedStage) return false;
  if (expectedStage === "building") return Number(job.goalWave ?? 0) === 0;
  if (expectedStage === "refining" || expectedStage === "validating") {
    return Number(job.goalWave ?? 0) === Number(mission.revisionWave ?? 0);
  }
  return true;
}

export function goalJobRunnableForMission(
  job: GoalPhaseJob,
  mission: GoalMissionLease,
  completedIds: Set<string>,
  now = Date.now(),
) {
  return job.status === "pending" &&
    Number(job.nextRunAt ?? 0) <= now &&
    (!job.approvalRequired || job.approvalStatus === "approved") &&
    goalJobMatchesMissionPhase(job, mission) &&
    (job.dependsOn ?? []).every((dependency) => completedIds.has(String(dependency)));
}

const clampText = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const slug = (value: unknown, fallback: string) =>
  clampText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
const strings = (value: unknown, maxItems: number, maxChars: number) =>
  (Array.isArray(value) ? value : [])
    .map((item) => clampText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);

function knownProject(text: string) {
  const normalized = text.toLowerCase();
  return PROJECT_REGISTRY.find((project) => {
    const names = [project.slug, project.name.toLowerCase(), project.repo.toLowerCase()];
    return names.some((name) => normalized.includes(name));
  });
}

export function routeGoal(goal: string, requestedRepo?: string): GoalRoute {
  const text = goal.toLowerCase();
  const requested = requestedRepo?.trim();
  const project = knownProject(`${goal} ${requested ?? ""}`);

  // Explicit ownership is stronger than broad content words. "Fix Jarvis's
  // video overlay" belongs to Jarvis, and a caller-supplied repository must
  // never be silently replaced with YouTube Studio.
  if (project?.slug === "youtube-studio-ai") {
    return {
      kind: "youtube_studio",
      primaryRepo: project.repo,
      project: project.slug,
      reason: "The outcome explicitly targets the existing modular YouTube Studio AI production system.",
      infrastructureContext:
        "Reuse YouTube Studio AI's module registry, crew/composer/critic loop, Remotion/FFmpeg render path, Convex state, Trigger tasks and R2 artifacts. Extend real modules and live callers; do not create a parallel video pipeline.",
    };
  }

  if (project?.slug === "app-factory-v2") {
    return {
      kind: "app_factory",
      primaryRepo: project.repo,
      project: project.slug,
      reason: "The outcome explicitly asks App Factory to own the application build lifecycle.",
      infrastructureContext:
        "Use App Factory v2's real idea-to-app state machine, current starter/design assets, Trigger stage runner, Convex records, R2 artifacts and Playwright/vision gates. The factory must produce a usable app rather than a mock. Keep its design and ship approvals intact.",
    };
  }

  if (project) {
    return {
      kind: "existing_project",
      primaryRepo: project.repo,
      project: project.slug,
      reason: `The goal explicitly targets the existing ${project.name} product.`,
      infrastructureContext: [
        `Work in ${project.repo}. Preserve its purpose (${project.purpose}) and invariants: ${project.invariants.join("; ")}. Inspect its current AGENTS.md, callers, manifests and live providers before planning changes.`,
        projectProviderBoundary(project.repo),
      ].filter(Boolean).join(" "),
    };
  }

  if (requested) {
    return {
      kind: "existing_project",
      primaryRepo: requested.includes("/") ? requested : `daniels-project-space/${requested}`,
      reason: "The caller supplied the repository that owns the outcome.",
      infrastructureContext:
        "Read the repository's current AGENTS.md and provider manifests first. Reuse its Convex, Trigger, Mastra, R2 and Vercel boundaries instead of creating cross-project glue.",
    };
  }

  const newProduct =
    /\b(build|create|make|launch|develop|ship)\b[\s\S]{0,50}\b(app|application|website|site|platform|saas|portal|dashboard|product)\b/.test(text) ||
    /\b(new|another)\s+(app|application|website|site|platform|saas|product)\b/.test(text);
  if (newProduct) {
    return {
      kind: "app_factory",
      primaryRepo: "daniels-project-space/app-factory-v2",
      project: "app-factory-v2",
      reason: "This is a new application outcome, so App Factory owns the build lifecycle.",
      infrastructureContext:
        "Use App Factory v2's real idea-to-app state machine, current starter/design assets, Trigger stage runner, Convex records, R2 artifacts and Playwright/vision gates. The factory must produce a usable app rather than a mock. Keep its design and ship approvals intact.",
    };
  }

  const videoWorkflow =
    /\b(youtube|episode|thumbnail|channel|footage|shorts?)\b/.test(text) ||
    /\b(edit|refine|render|produce)\w*\b[\s\S]{0,50}\b(video|episode|footage)\b/.test(text) ||
    /\b(video|episode|footage)\b[\s\S]{0,50}\b(edit|refine|render|produce)\w*\b/.test(text);
  if (videoWorkflow) {
    return {
      kind: "youtube_studio",
      primaryRepo: "daniels-project-space/youtube-studio-ai",
      project: "youtube-studio-ai",
      reason: "The outcome belongs in the existing modular YouTube Studio AI production system.",
      infrastructureContext:
        "Reuse YouTube Studio AI's module registry, crew/composer/critic loop, Remotion/FFmpeg render path, Convex state, Trigger tasks and R2 artifacts. Extend real modules and live callers; do not create a parallel video pipeline.",
    };
  }

  if (/\b(infrastructure|service|backend|worker|pipeline|integration|orchestrat|database|cloud|api)\b/.test(text)) {
    return {
      kind: "cloud_new",
      reason: "The goal appears to need genuinely new cloud infrastructure rather than an existing product module.",
      infrastructureContext:
        "Follow Daniel's cloud-project standard: a self-contained repository in daniels-project-space with its own Vercel project, isolated Convex deployment, isolated Trigger project/tasks, Mastra orchestration where useful, R2 bucket when artifacts are large, scoped vault access, and Project Hub/Jarvis registration. Production creation, publishing and spend stay approval-gated.",
    };
  }

  return {
    kind: "general",
    reason: "No existing product or new-app pipeline is unambiguously implied; the deep planner must establish the smallest correct ownership boundary.",
    infrastructureContext:
      "Inspect Daniel's current project registry and infrastructure guidance before proposing new code. Prefer an existing product boundary when it genuinely owns the capability; otherwise follow the isolated cloud-project standard.",
  };
}

function balancedObjectAfter(text: string, marker: string): string | null {
  const markerAt = text.lastIndexOf(marker);
  if (markerAt < 0) return null;
  const start = text.indexOf("{", markerAt + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseMarkedObject(text: string, marker: string): Record<string, unknown> {
  const raw = balancedObjectAfter(text, marker);
  if (!raw) throw new Error(`Missing ${marker} structured result`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${marker} contains invalid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${marker} must contain one JSON object`);
  return value as Record<string, unknown>;
}

function topologicalWorkstreams(workstreams: GoalWorkstream[]): GoalWorkstream[] {
  validateWorkDag(workstreams, 8);
  const byId = new Map(workstreams.map((stream) => [stream.id, stream]));
  const emitted = new Set<string>();
  const ordered: GoalWorkstream[] = [];
  while (ordered.length < workstreams.length) {
    const ready = workstreams.find(
      (stream) => !emitted.has(stream.id) && stream.dependsOn.every((dependency) => emitted.has(dependency)),
    );
    if (!ready) throw new Error("Goal plan workstream dependencies contain a cycle");
    if (ready.dependsOn.some((dependency) => !byId.has(dependency))) {
      throw new Error(`Goal plan workstream ${ready.id} depends on an unknown workstream`);
    }
    ordered.push(ready);
    emitted.add(ready.id);
  }
  return ordered;
}

export function parseGoalPlan(text: string, maxBuildSessions = 6): GoalPlan {
  const input = parseMarkedObject(text, GOAL_PLAN_MARKER);
  const rawStreams = Array.isArray(input.workstreams) ? input.workstreams : [];
  const limit = Math.max(1, Math.min(8, Math.floor(maxBuildSessions || 6)));
  if (rawStreams.length < 1 || rawStreams.length > limit) {
    throw new Error(`Goal plan must contain 1-${limit} necessary workstreams`);
  }
  const outcomeInput = input.outcome && typeof input.outcome === "object"
    ? input.outcome as Record<string, unknown>
    : null;
  if (!outcomeInput) throw new Error("Goal plan requires a measurable outcome contract");
  const outcome: GoalOutcomeContract = {
    objective: clampText(outcomeInput.objective, 800),
    metric: clampText(outcomeInput.metric, 300),
    baseline: clampText(outcomeInput.baseline, 800),
    target: clampText(outcomeInput.target, 800),
    measurementWindow: clampText(outcomeInput.measurementWindow ?? outcomeInput.measurement_window, 300),
    evidenceSources: strings(outcomeInput.evidenceSources ?? outcomeInput.evidence_sources, 8, 500),
    stopConditions: strings(outcomeInput.stopConditions ?? outcomeInput.stop_conditions, 8, 500),
  };
  if (outcome.objective.length < 12 || outcome.metric.length < 3
    || outcome.baseline.length < 8 || outcome.target.length < 8
    || outcome.measurementWindow.length < 3 || outcome.evidenceSources.length === 0
    || outcome.stopConditions.length === 0) {
    throw new Error("Goal outcome must define objective, metric, baseline, target, measurement window, evidence sources, and stop conditions");
  }
  const crewInput = input.crew && typeof input.crew === "object"
    ? input.crew as Record<string, unknown>
    : null;
  if (!crewInput || clampText(crewInput.process, 30) !== "hierarchical"
    || clampText(crewInput.manager, 30) !== "jarvis") {
    throw new Error("Goal plan requires a hierarchical crew managed by jarvis");
  }
  const crew: GoalCrewCharter = {
    process: "hierarchical",
    manager: "jarvis",
    delegationRules: strings(crewInput.delegationRules ?? crewInput.delegation_rules, 8, 500),
    humanEscalation: strings(crewInput.humanEscalation ?? crewInput.human_escalation, 8, 500),
    reportingCadence: clampText(crewInput.reportingCadence ?? crewInput.reporting_cadence, 300),
  };
  if (!crew.delegationRules.length || !crew.humanEscalation.length || crew.reportingCadence.length < 3) {
    throw new Error("Goal crew must define delegation, human escalation, and reporting rules");
  }
  const used = new Set<string>();
  const allowedAgents = new Set(["paul", "atlas", "iris", "maya", "chloe", "sentry"]);
  const streams: GoalWorkstream[] = rawStreams.map((raw, index) => {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = slug(row.id, `work-${index + 1}`);
    if (used.has(id)) throw new Error(`Goal plan contains duplicate workstream id ${id}`);
    used.add(id);
    const task = clampText(row.task, 5_000);
    if (task.length < 20) throw new Error(`Goal plan workstream ${id} needs a concrete task`);
    const requestedAgent = clampText(row.agentId ?? row.agent_id, 20).toLowerCase();
    const agentId = (allowedAgents.has(requestedAgent) ? requestedAgent : "paul") as GoalWorkstream["agentId"];
    const deliverableInput = row.deliverable && typeof row.deliverable === "object"
      ? row.deliverable as Record<string, unknown>
      : null;
    const deliverableKind = clampText(deliverableInput?.kind, 40) as GoalDeliverableKind;
    const deliverable: GoalWorkstreamDeliverable = {
      kind: GOAL_DELIVERABLE_KINDS.includes(deliverableKind) ? deliverableKind : "operational_result",
      description: clampText(deliverableInput?.description, 800),
      requiredEvidence: strings(
        deliverableInput?.requiredEvidence ?? deliverableInput?.required_evidence,
        8,
        500,
      ),
    };
    const guardrails = strings(row.guardrails, 8, 500);
    if (!deliverableInput || deliverable.description.length < 12 || !deliverable.requiredEvidence.length) {
      throw new Error(`Goal plan workstream ${id} requires a structured deliverable and evidence contract`);
    }
    if (!guardrails.length) throw new Error(`Goal plan workstream ${id} requires at least one explicit guardrail`);
    return {
      id,
      label: clampText(row.label, 80) || `Workstream ${index + 1}`,
      task,
      agentId,
      repo: (() => {
        const supplied = clampText(row.repo, 160);
        if (!supplied) return undefined;
        const canonical = canonicalizeRepository(supplied, { allowShortName: true });
        if (!canonical) throw new Error(`Goal plan workstream ${id} has an invalid repository scope`);
        return canonical;
      })(),
      readonly: row.readonly === true,
      dependsOn: strings(row.dependsOn ?? row.depends_on, 8, 48).map((dependency) => slug(dependency, "")),
      acceptanceCriteria: strings(row.acceptanceCriteria ?? row.acceptance_criteria, 8, 500).length
        ? strings(row.acceptanceCriteria ?? row.acceptance_criteria, 8, 500)
        : ["Deliver the scoped outcome with concrete verification evidence"],
      deliverable,
      guardrails,
      mcp: strings(row.mcp, 2, 20).filter((name): name is "playwright" | "context7" => name === "playwright" || name === "context7"),
    };
  });
  const validIds = new Set(streams.map((stream) => stream.id));
  for (const stream of streams) {
    if (stream.dependsOn.some((dependency) => !validIds.has(dependency))) {
      throw new Error(`Goal plan workstream ${stream.id} depends on an unknown workstream`);
    }
  }
  const validation = input.validation && typeof input.validation === "object"
    ? input.validation as Record<string, unknown>
    : {};
  const route = clampText(input.route, 40) as GoalRouteKind;
  const normalizedRoute = GOAL_ROUTE_KINDS.includes(route) ? route : "general";
  const factoryInput = input.factory && typeof input.factory === "object"
    ? input.factory as Record<string, unknown>
    : null;
  const factory = factoryInput
    ? {
        name: clampText(factoryInput.name, 80),
        slug: slug(factoryInput.slug ?? factoryInput.name, "new-app"),
        brief: clampText(factoryInput.brief, 3_000),
      }
    : undefined;
  if (normalizedRoute === "app_factory" && (!factory?.name || factory.brief.length < 20)) {
    throw new Error("App Factory goal plans require factory name, slug and concrete brief");
  }
  return {
    summary: clampText(input.summary, 1_200) || "A staged plan for the requested outcome.",
    route: normalizedRoute,
    primaryRepo: (() => {
      const supplied = clampText(input.primaryRepo ?? input.primary_repo, 160);
      if (!supplied) return undefined;
      const canonical = canonicalizeRepository(supplied, { allowShortName: true });
      if (!canonical) throw new Error("Goal plan has an invalid primary repository scope");
      return canonical;
    })(),
    assumptions: strings(input.assumptions, 8, 500),
    outcome,
    crew,
    workstreams: topologicalWorkstreams(streams),
    validation: {
      criteria: strings(validation.criteria, 12, 500).length
        ? strings(validation.criteria, 12, 500)
        : ["The requested outcome works end to end"],
      tests: strings(validation.tests, 12, 500),
      liveChecks: strings(validation.liveChecks ?? validation.live_checks, 12, 500),
    },
    factory,
  };
}

export function parseGoalValidation(text: string): GoalValidation {
  const input = parseMarkedObject(text, GOAL_VALIDATION_MARKER);
  const verdict = clampText(input.verdict, 20).toLowerCase();
  if (verdict !== "pass" && verdict !== "refine" && verdict !== "blocked") {
    throw new Error("Goal validation verdict must be pass, refine or blocked");
  }
  const evidence = strings(input.evidence, 16, 800);
  const outcomeAchieved = input.outcomeAchieved === true || input.outcome_achieved === true;
  const outcomeEvidence = strings(input.outcomeEvidence ?? input.outcome_evidence, 16, 800);
  const stopConditionsSatisfied = strings(
    input.stopConditionsSatisfied ?? input.stop_conditions_satisfied,
    12,
    500,
  );
  const observedInput = input.observedOutcome && typeof input.observedOutcome === "object"
    ? input.observedOutcome as Record<string, unknown>
    : input.observed_outcome && typeof input.observed_outcome === "object"
      ? input.observed_outcome as Record<string, unknown>
      : null;
  const observedOutcome = observedInput ? {
    metric: clampText(observedInput.metric, 300),
    baseline: clampText(observedInput.baseline, 800),
    observed: clampText(observedInput.observed, 800),
    target: clampText(observedInput.target, 800),
    measurementWindow: clampText(observedInput.measurementWindow ?? observedInput.measurement_window, 300),
  } : undefined;
  if (verdict === "pass" && (evidence.length < 2 || !outcomeAchieved
    || outcomeEvidence.length < 2 || stopConditionsSatisfied.length === 0
    || !observedOutcome?.metric || !observedOutcome.baseline || !observedOutcome.observed
    || !observedOutcome.target || !observedOutcome.measurementWindow)) {
    throw new Error("A passing goal validation requires measured target evidence and satisfied stop conditions, not task or deployment proxies");
  }
  const refinements = (Array.isArray(input.refinements) ? input.refinements : []).slice(0, 3).map((raw, index) => {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const task = clampText(row.task, 4_000);
    if (task.length < 20) throw new Error("Every goal refinement needs a concrete repair task");
    return {
      id: slug(row.id, `refine-${index + 1}`),
      label: clampText(row.label, 80) || `Refinement ${index + 1}`,
      task,
      acceptanceCriteria: strings(row.acceptanceCriteria ?? row.acceptance_criteria, 8, 500).length
        ? strings(row.acceptanceCriteria ?? row.acceptance_criteria, 8, 500)
        : ["Close the validator's stated gap and re-run the relevant checks"],
    };
  });
  if (verdict === "refine" && refinements.length === 0) {
    throw new Error("A refine verdict must include at least one bounded refinement");
  }
  return {
    verdict,
    summary: clampText(input.summary, 1_600) || "Deep validation completed.",
    evidence,
    outcomeAchieved,
    outcomeEvidence,
    stopConditionsSatisfied,
    observedOutcome,
    gaps: strings(input.gaps, 12, 800),
    refinements,
    blocker: clampText(input.blocker, 1_200) || undefined,
  };
}

export function goalBranch(goal: string, missionId: string): string {
  const label = slug(goal, "outcome").slice(0, 30);
  const suffix = missionId.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toLowerCase() || "goal";
  return `jarvis/goal-${label}-${suffix}`;
}

export function plannerTask(goal: string, route: GoalRoute, acceptanceCriteria: string[], maxBuildSessions: number): string {
  return [
    "GOAL MODE — DEEP PLANNING SESSION. Plan only; do not edit, deploy, publish, or start implementation.",
    `Outcome: ${goal}`,
    `Deterministic route: ${route.kind}${route.primaryRepo ? ` · ${route.primaryRepo}` : ""}`,
    `Why: ${route.reason}`,
    `Reuse boundary: ${route.infrastructureContext}`,
    acceptanceCriteria.length ? `Daniel's acceptance criteria:\n${acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
    `Act as the hierarchical crew manager. Inspect the current repository, AGENTS.md, callers, live manifests and relevant primary-source docs. Find existing skills, templates and infrastructure before proposing new code. First define one measurable outcome contract: current baseline, primary metric, target, measurement window, authoritative evidence sources, and exact stop conditions. A business goal about profit must measure net contribution after attributable costs, refunds, fees and acquisition expense; sales, traffic, code shipped, or a deployment are not profit.`,
    `Create only the ${maxBuildSessions === 1 ? "single necessary" : `1-${maxBuildSessions} necessary`} workstream${maxBuildSessions === 1 ? "" : "s"}; never add a ceremonial specialist merely to make a larger crew. Assign Paul to engineering/integration, Atlas to evidence research, Iris to media/visual quality, Maya to travel/calendar work, Chloe to social/content operations, and Sentry to reliability/security review. Give each workstream one structured deliverable, required evidence and explicit guardrails. Express only real ordering requirements as dependsOn edges; verified upstream outputs become the dependent worker's context. Continue reversible independent work before escalating, and ask Daniel only for the smallest genuinely protected decision. Once every stop condition is proved, stop the crew and leave no polling worker running merely to look busy.`,
    `When quality defects are found, fix their generation, render, configuration, or data root cause; detection filters are secondary regression guards and a rejection-only gate does not satisfy the outcome. Independent writable sessions may run concurrently because every work item receives its own immutable worker branch and sandbox; specialists never share or integrate branches. Agents do not merge or deploy directly: the fenced delivery controller serializes reviewed receipts into the mission integration branch. Actions with public, third-party communication, financial, credential, booking, or destructive consequences remain separately approval-gated.`,
    "End with exactly one compact JSON object after GOAL_PLAN_JSON:. It must use this shape:",
    '{"summary":"...","route":"app_factory|youtube_studio|existing_project|cloud_new|general","primaryRepo":"owner/repo or empty","assumptions":["..."],"outcome":{"objective":"...","metric":"one primary metric","baseline":"current measured state/source","target":"observable threshold","measurementWindow":"...","evidenceSources":["authoritative source"],"stopConditions":["condition that ends work"]},"crew":{"process":"hierarchical","manager":"jarvis","delegationRules":["only necessary specialists"],"humanEscalation":["protected decision only after independent work"],"reportingCadence":"event-driven checkpoints; no idle polling"},"workstreams":[{"id":"stable-id","label":"short label","task":"self-contained task","agentId":"paul|atlas|iris|maya|chloe|sentry","repo":"owner/repo or empty","readonly":false,"dependsOn":["earlier-id"],"acceptanceCriteria":["observable evidence"],"deliverable":{"kind":"code_change|research_brief|creative_artifact|operational_result|decision_brief","description":"exact output","requiredEvidence":["proof"]},"guardrails":["explicit boundary"],"mcp":["playwright|context7"]}],"validation":{"criteria":["goal-level truth"],"tests":["deep test"],"liveChecks":["deployed/provider check"]},"factory":{"name":"required only for app_factory","slug":"...","brief":"full build brief"}}',
    "The JSON is a machine contract. Keep the whole response and JSON concise enough to fit in 7,500 characters.",
  ].filter(Boolean).join("\n\n");
}

export function validatorTask(args: {
  goal: string;
  plan: GoalPlan;
  acceptanceCriteria: string[];
  buildEvidence: Array<{ label: string; status: string; result: string }>;
  revisionWave: number;
  externalContext?: string;
  auditSnapshot?: string;
}): string {
  const evidence = args.buildEvidence
    .map((item) => `### ${item.label.slice(0, 120)} [${item.status.slice(0, 40)}]\n${item.result.slice(0, 1_000)}`)
    .join("\n\n")
    .slice(0, 8_000);
  const bullets = (items: string[], maxChars: number) => items
    .map((item) => `- ${String(item).slice(0, 500)}`)
    .join("\n")
    .slice(0, maxChars);
  const prompt = [
    "GOAL MODE — DEEP FINAL VALIDATION SESSION. Be the skeptical owner of the outcome, not a summary writer.",
    `Outcome: ${args.goal.slice(0, 1_000)}`,
    `Revision wave: ${args.revisionWave}`,
    `Plan summary: ${args.plan.summary.slice(0, 1_500)}`,
    [
      "MEASURABLE OUTCOME CONTRACT:",
      `Objective: ${args.plan.outcome.objective}`,
      `Primary metric: ${args.plan.outcome.metric}`,
      `Baseline: ${args.plan.outcome.baseline}`,
      `Target: ${args.plan.outcome.target}`,
      `Measurement window: ${args.plan.outcome.measurementWindow}`,
      `Authoritative evidence sources:\n${bullets(args.plan.outcome.evidenceSources, 2_500)}`,
      `Stop conditions:\n${bullets(args.plan.outcome.stopConditions, 2_500)}`,
    ].join("\n"),
    args.externalContext ? `External build ownership:\n${args.externalContext.slice(0, 3_000)}` : "",
    `Goal criteria:\n${bullets([...args.acceptanceCriteria, ...args.plan.validation.criteria], 4_000)}`,
    args.plan.validation.tests.length ? `Required tests:\n${bullets(args.plan.validation.tests, 3_000)}` : "",
    args.plan.validation.liveChecks.length ? `Required live/provider checks:\n${bullets(args.plan.validation.liveChecks, 3_000)}` : "",
    `Builder evidence:\n${evidence}`,
    args.auditSnapshot
      ? [
          "Delivery-controller audit snapshot (captured server-side when this validator was queued):",
          args.auditSnapshot.slice(0, 8_000),
          "Treat this as the scoped read evidence for protected Convex state. Do not mint a viewer session or weaken authentication merely to re-fetch it. An otherwise consistent protected history being unavailable inside the sandbox is not, by itself, a blocker; verify the snapshot against source, tests, and public provider evidence.",
        ].join("\n")
      : "",
    EVIDENCE_INTEGRITY_RULES,
    SAFE_SANDBOX_EXECUTION_RULES,
    "Inspect the actual branch and current code. Run proportionate deep tests, typecheck/build, end-to-end or browser checks, and exact provider/deployment checks where the goal requires them. A command exit code alone is not proof. Do not merge or deploy yourself; a pass hands the branch to the automatic delivery controller. Do not publish publicly, spend, message or perform destructive actions. If a gap is fixable in the existing scope, return refine with 1-3 precise Terra repair sessions. Use blocked only for a genuine Daniel/external decision after independent work is exhausted. Use pass only when the measured target—not merely each task, code change, deployment, traffic, or revenue proxy—is evidenced for the declared window and every stop condition is satisfied. When it passes, the crew stops; do not invent follow-on work.",
    "End with exactly one compact JSON object after GOAL_VALIDATION_JSON: using:",
    '{"verdict":"pass|refine|blocked","summary":"...","evidence":["exact check/result"],"outcomeAchieved":false,"outcomeEvidence":["authoritative measured evidence"],"stopConditionsSatisfied":["exact satisfied condition"],"observedOutcome":{"metric":"...","baseline":"...","observed":"...","target":"...","measurementWindow":"..."},"gaps":["..."],"refinements":[{"id":"...","label":"...","task":"self-contained repair","acceptanceCriteria":["..."]}],"blocker":"only when blocked"}',
    "The JSON is a machine contract. Keep it under 3,500 characters.",
  ].filter(Boolean).join("\n\n");
  if (prompt.length <= GOAL_VALIDATOR_TASK_MAX_CHARS) return prompt;

  // Keep the machine-readable result contract even if unexpectedly large
  // evidence reaches this final defensive boundary. Normalized Goal Mode
  // inputs fit below the cap; this fallback protects the parser from a raw
  // prefix truncation that would otherwise remove its required output shape.
  const contractAt = prompt.lastIndexOf("\n\nEnd with exactly one compact JSON object");
  if (contractAt < 0) return prompt.slice(0, GOAL_VALIDATOR_TASK_MAX_CHARS);
  const tail = prompt.slice(contractAt);
  const omission = "\n\n[Earlier validation evidence was truncated at the durable task boundary.]";
  const headChars = Math.max(0, GOAL_VALIDATOR_TASK_MAX_CHARS - tail.length - omission.length);
  return `${prompt.slice(0, headChars).trimEnd()}${omission}${tail}`;
}
