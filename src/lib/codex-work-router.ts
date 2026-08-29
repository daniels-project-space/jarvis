import {
  normalizeWorkModelTier,
  parseWorkModelTier,
  workModelLabel,
  type WorkModelTier,
} from "./work-models";

// These names are passed straight to the subscribed Codex runtime. Keep the
// normal durable-work route on Terra/xhigh; `ultra` is an intentional opt-in
// for unusually difficult work, and Sol/max is the exceptional safety route.
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "ultra", "max"] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export type CodexWorkType = "research" | "architecture" | "implementation" | "verification" | "synthesis";
export type CodexWorkComplexity = "bounded" | "standard" | "complex" | "intense";
export type CodexWorkUncertainty = "low" | "medium" | "high";
export type CodexProductionRisk = "low" | "medium" | "high" | "critical";
export type CodexExpectedDuration = "short" | "medium" | "long";
export type CodexToolBreadth = "narrow" | "moderate" | "broad";

export type CodexWorkPolicyInput = {
  task: string;
  role?: string;
  repo?: string | null;
  readonly?: boolean;
  risk?: string;
  tools?: readonly unknown[];
  workType?: CodexWorkType;
  complexity?: CodexWorkComplexity;
  uncertainty?: CodexWorkUncertainty;
  productionRisk?: CodexProductionRisk;
  expectedDuration?: CodexExpectedDuration;
  toolBreadth?: CodexToolBreadth;
  crossProject?: boolean;
  requestedModel?: unknown;
  requestedReasoningEffort?: unknown;
};

export type CodexWorkSelection = {
  model: WorkModelTier;
  reasoningEffort: CodexReasoningEffort;
  modelReason: string;
  workType: CodexWorkType;
  complexity: CodexWorkComplexity;
  uncertainty: CodexWorkUncertainty;
  productionRisk: CodexProductionRisk;
  expectedDuration: CodexExpectedDuration;
  toolBreadth: CodexToolBreadth;
  crossProject: boolean;
};

export type CodexRetrySelection = Pick<CodexWorkSelection, "model" | "reasoningEffort" | "modelReason"> & {
  escalated: boolean;
};

const TIER_RANK: Record<WorkModelTier, number> = { luna: 0, terra: 1, sol: 2 };
const EFFORT_RANK: Record<CodexReasoningEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  ultra: 4,
  max: 5,
};

const RESEARCH = /\b(research|compare|survey|primary sources?|literature|market|competitor|find out|summari[sz]e|analyse|analyze)\b/i;
const ARCHITECTURE = /\b(architecture|architectural|system design|redesign|platform design|migration plan|technical strategy)\b/i;
const IMPLEMENTATION = /\b(implement|apply|build|code|fix|repair|refactor|migrat(?:e|ion|ing)?|edit|change|feature|bug|schema|api|database|typescript|react|next\.?js|convex|trigger)\b/i;
const VERIFICATION = /\b(verify|validate|verification|test|review|audit|check|prove|quality assurance|qa)\b/i;
const SYNTHESIS = /\b(synthesi[sz]e|synthesis|weave|merge findings|consolidate|roll up|cross-project brief)\b/i;
const BOUNDED = /\b(bounded|deterministic|one[- ]file|single[- ]file|small|routine|straightforward|exact|known fix|typo|rename|mechanical)\b/i;
const COMPLEX = /\b(multi[- ]file|end[- ]to[- ]end|distributed|concurrent|race condition|state machine|integration|large refactor|redesign|migration)\b/i;
const INTENSE = /\b(core architecture|system[- ]wide|cross[- ]project|multi[- ]repo|cross[- ]repo|deep root cause|difficult root cause|recurring root cause|production outage|security incident|privacy incident|overhaul|from first principles)\b/i;
const UNCERTAIN = /\b(unknown|unclear|ambiguous|intermittent|novel|exploratory|investigate|root cause|trade[- ]offs?|compare|current landscape)\b/i;
const CERTAIN = /\b(deterministic|exact|known|mechanical|typo|rename|contract[- ]defined|reproduce the supplied|fixed fixture)\b/i;
const LONG = /\b(long[- ]running|multi[- ]hour|hours|days|multi[- ]day|end[- ]to[- ]end|cross[- ]project|multi[- ]repo|overhaul)\b/i;
const SHORT = /\b(quick|brief|bounded|one[- ]file|single[- ]file|small|routine|deterministic|mechanical)\b/i;
const SECURITY = /\b(security|privacy|authentication|authorization|permissions?|credentials?|secrets?|tenant isolation|customer data|personal data|pii|payment)\b/i;
const PRODUCTION = /\b(production|live|deploy|release|customer-facing|user data|data loss|outage|incident)\b/i;
const BROAD_TOOLS = /\b(browser|playwright|provider|production logs?|web search|multiple repositories|cross[- ]project|multi[- ]repo)\b/i;
// A direct Sol/max request is exceptional. General requests for the best
// answer stay on Terra/ultra so they retain quality without treating common
// emphatic language as permission to spend the frontier route.
const EXPLICIT_SOL_MAX = /\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+(?:the\s+)?sol\s*\/\s*max\b|\bsol\s*\/\s*max\b/i;
const EXPLICIT_PREFERRED_ULTRA = /\b(max(?:imum)? quality|highest quality|best available (?:model|reasoning)|deepest reasoning|think (?:very |really )?hard|do not economi[sz]e)\b/i;
const EXPLICIT_HIGH_QUALITY = /\b(?:at|with|use|using|choose|select)?\s*high[- ]quality\b/i;
const EXPLICIT_HIGH_EFFORT = /\bhigh reasoning effort\b|\breasoning effort(?:\s+(?:of|is|at)|\s*[:=])?\s*high\b/i;
const EXPLICIT_TERRA = /\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+(?:the\s+)?terra(?:\/(?:low|medium|high|xhigh|max|ultra))?\b|\bterra\/(?:low|medium|high|xhigh|max|ultra)\b/i;
const EXPLICIT_SOL = /\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+(?:the\s+)?sol(?:\/(?:low|medium|high|xhigh|max|ultra))?\b|\bsol\/(?:low|medium|high|xhigh|max|ultra)\b/i;
const EXPLICIT_LUNA = /\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+(?:the\s+)?luna(?:\/(?:low|medium|high|xhigh|max|ultra))?\b|\bluna\/(?:low|medium|high|xhigh|max|ultra)\b/i;
const EXPLICIT_ULTRA_EFFORT = /\b(?:luna|terra|sol)(?:\/|\s+)ultra\b|\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+ultra\b|\bultra\s+(?:reasoning(?:\s+effort)?|effort)\b/i;
const EXPLICIT_XHIGH_EFFORT = /\b(?:luna|terra|sol)(?:\/|\s+)x[- ]?high\b|\b(?:use|using|choose|select|run(?: this)? (?:on|with))\s+x[- ]?high\b|\bx[- ]?high\s+(?:reasoning(?:\s+effort)?|effort)\b/i;
const DIFFICULT_ROOT_CAUSE = /\b(?:deep|difficult|recurring|intermittent|unknown|production) root cause\b|\broot cause\b.*\b(?:production|security|privacy|cross[- ]project|multi[- ]repo)\b/i;

function boundedText(value: unknown, max = 120): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}
export function parseCodexReasoningEffort(value: unknown): CodexReasoningEffort | null {
  const effort = String(value ?? "").trim().toLowerCase();
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? effort as CodexReasoningEffort
    : null;
}

export function normalizeCodexReasoningEffort(
  value: unknown,
  fallback: CodexReasoningEffort,
): CodexReasoningEffort {
  return parseCodexReasoningEffort(value) ?? fallback;
}

function maxTier(left: WorkModelTier, right: WorkModelTier): WorkModelTier {
  return TIER_RANK[left] >= TIER_RANK[right] ? left : right;
}

function maxEffort(left: CodexReasoningEffort, right: CodexReasoningEffort): CodexReasoningEffort {
  return EFFORT_RANK[left] >= EFFORT_RANK[right] ? left : right;
}

function explicitTextModel(task: string): WorkModelTier | null {
  if (EXPLICIT_SOL_MAX.test(task) || EXPLICIT_SOL.test(task)) return "sol";
  if (EXPLICIT_HIGH_QUALITY.test(task) || EXPLICIT_TERRA.test(task)) return "terra";
  if (EXPLICIT_LUNA.test(task)) return "luna";
  return null;
}

function explicitTextEffort(task: string): CodexReasoningEffort | null {
  if (EXPLICIT_ULTRA_EFFORT.test(task) || EXPLICIT_PREFERRED_ULTRA.test(task)) return "ultra";
  if (EXPLICIT_SOL_MAX.test(task) || /\b(?:luna|terra|sol)\/max\b|\bmax(?:imum)? reasoning effort\b/i.test(task)) return "max";
  if (EXPLICIT_XHIGH_EFFORT.test(task)) return "xhigh";
  if (EXPLICIT_HIGH_QUALITY.test(task) || EXPLICIT_HIGH_EFFORT.test(task) || /\b(?:luna|terra|sol)\/high\b/i.test(task)) return "high";
  if (/\b(?:luna|terra|sol)\/medium\b|\bmedium reasoning effort\b/i.test(task)) return "medium";
  if (/\b(?:luna|terra|sol)\/low\b|\blow reasoning effort\b/i.test(task)) return "low";
  return null;
}

function inferWorkType(task: string, role: string): CodexWorkType {
  if (/planner|architect/.test(role)) return "architecture";
  if (/validator|verifier|reviewer/.test(role)) return "verification";
  if (/synthesi[sz]er/.test(role)) return "synthesis";
  if (role === "iris") return "implementation";
  if (/^(?:research|compare|survey|find|summari[sz]e|analyse|analyze)\b/i.test(task.trim())) return "research";
  if (SYNTHESIS.test(task)) return "synthesis";
  if (ARCHITECTURE.test(task)) return "architecture";
  if (IMPLEMENTATION.test(task)) return "implementation";
  if (RESEARCH.test(task) || role === "atlas") return "research";
  if (VERIFICATION.test(task) || role === "sentry") return "verification";
  if (role === "paul") return "implementation";
  return "research";
}

function inferComplexity(task: string, workType: CodexWorkType, crossProject: boolean): CodexWorkComplexity {
  if (crossProject || INTENSE.test(task) || task.length > 2_000) return "intense";
  if (BOUNDED.test(task) && task.length < 900) return "bounded";
  if (COMPLEX.test(task) || workType === "architecture" || task.length > 700) return "complex";
  return "standard";
}

function inferUncertainty(task: string, workType: CodexWorkType, complexity: CodexWorkComplexity): CodexWorkUncertainty {
  if (CERTAIN.test(task) && complexity === "bounded") return "low";
  if (UNCERTAIN.test(task) || complexity === "intense") return "high";
  if (workType === "research" || workType === "architecture") return "medium";
  return complexity === "bounded" ? "low" : "medium";
}

function inferProductionRisk(task: string, repo: string, readonly: boolean, risk: string): CodexProductionRisk {
  const security = SECURITY.test(task);
  const production = PRODUCTION.test(task);
  // Human-gated consequential work needs care, but it is not automatically a
  // reason to spend the frontier/max route. Reserve that for cases involving
  // production or sensitive data where a reasoning failure itself is severe.
  if (risk === "consequential" && (security || production)) return "critical";
  if (security && production) return "critical";
  if (security || production || risk === "high" || risk === "consequential") return "high";
  if (risk === "medium" || (repo && !readonly) || /\b(database|schema|migration|api)\b/i.test(task)) return "medium";
  return "low";
}

function inferDuration(task: string, workType: CodexWorkType, complexity: CodexWorkComplexity): CodexExpectedDuration {
  if (LONG.test(task) || complexity === "intense") return "long";
  if (SHORT.test(task) && complexity === "bounded") return "short";
  if (complexity === "complex" || workType === "architecture" || task.length > 500) return "medium";
  return task.length < 220 ? "short" : "medium";
}

function inferToolBreadth(task: string, tools: readonly unknown[], crossProject: boolean): CodexToolBreadth {
  if (crossProject || tools.length >= 3 || (tools.length >= 2 && BROAD_TOOLS.test(task))) return "broad";
  if (tools.length >= 2 || BROAD_TOOLS.test(task)) return "moderate";
  return "narrow";
}

function selectionLead(input: {
  task: string;
  workType: CodexWorkType;
  complexity: CodexWorkComplexity;
  productionRisk: CodexProductionRisk;
  expectedDuration: CodexExpectedDuration;
  crossProject: boolean;
  explicitQuality: boolean;
  model: WorkModelTier;
}): string {
  if (input.explicitQuality) return "Explicit quality floor retained";
  if (input.productionRisk === "critical") return "Exceptional security/privacy safety floor";
  if (DIFFICULT_ROOT_CAUSE.test(input.task)) return "Difficult root-cause work";
  if (input.workType === "synthesis" && input.crossProject) return "Cross-project synthesis";
  if (input.workType === "architecture" && input.model === "terra") return "Architecture on Terra";
  if (input.workType === "research" && input.model === "luna") return "Exact bounded research reflex";
  if (input.workType === "synthesis" && input.model === "luna") return "Bounded deterministic synthesis";
  if (input.workType === "implementation" && input.model === "terra") return "Implementation quality default";
  if (input.workType === "verification" && input.model === "luna") return "Routine deterministic verification";
  if (input.expectedDuration === "long") return "Long-running supervised work";
  return `${input.workType[0].toUpperCase()}${input.workType.slice(1)} workload`;
}

/**
 * The one deterministic durable-work router. It treats caller model/effort
 * values as quality floors, never ceilings, so an explicit high-quality choice
 * is retained while security and production safety can still raise a cheap
 * request.
 */
export function selectCodexWorkPolicy(input: CodexWorkPolicyInput): CodexWorkSelection {
  const task = String(input.task ?? "").trim();
  const role = boundedText(input.role || "jarvis", 40).toLowerCase() || "jarvis";
  const repo = boundedText(input.repo, 160);
  const readonly = input.readonly === true;
  const crossProject = input.crossProject === true
    || /\b(cross[- ]project|multi[- ]repo|cross[- ]repo|across (?:several|multiple|all) (?:projects|repositories))\b/i.test(task);
  const workType = input.workType ?? inferWorkType(task, role);
  const complexity = input.complexity ?? inferComplexity(task, workType, crossProject);
  const uncertainty = input.uncertainty ?? inferUncertainty(task, workType, complexity);
  const productionRisk = input.productionRisk
    ?? inferProductionRisk(task, repo, readonly, boundedText(input.risk, 24).toLowerCase());
  const expectedDuration = input.expectedDuration ?? inferDuration(task, workType, complexity);
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const toolBreadth = input.toolBreadth ?? inferToolBreadth(task, tools, crossProject);
  const proseModelFloor = explicitTextModel(task);
  const proseEffortFloor = explicitTextEffort(task);
  const explicitSolMax = EXPLICIT_SOL_MAX.test(task);
  const explicitQuality = explicitSolMax || EXPLICIT_PREFERRED_ULTRA.test(task)
    || EXPLICIT_HIGH_QUALITY.test(task) || EXPLICIT_HIGH_EFFORT.test(task)
    || proseModelFloor === "sol" || proseModelFloor === "terra";
  const difficultRootCause = DIFFICULT_ROOT_CAUSE.test(task);

  const exactCheapReflex = readonly
    && complexity === "bounded"
    && uncertainty === "low"
    && expectedDuration === "short"
    && toolBreadth === "narrow"
    && (workType === "research" || workType === "verification" || workType === "synthesis");
  // Terra is the normal durable-work choice. Luna is deliberately restricted
  // to short, read-only, deterministic reflexes; difficult work gets more
  // Terra reasoning rather than jumping straight to Sol.
  let model: WorkModelTier = exactCheapReflex ? "luna" : "terra";
  const requiresSolMax = productionRisk === "critical" || (SECURITY.test(task) && productionRisk === "high");
  if (requiresSolMax) {
    model = "sol";
  } else if (difficultRootCause && model === "luna") {
    // Root-cause language is common in ordinary repair prompts. It warrants a
    // deeper reasoning pass, but does not by itself justify the most expensive
    // tier for a bounded, reversible change in one owned repository.
    model = "terra";
  }
  if (explicitSolMax) model = "sol";

  const structuredModelFloor = parseWorkModelTier(input.requestedModel);
  const requestedModel = structuredModelFloor && proseModelFloor
    ? maxTier(structuredModelFloor, proseModelFloor)
    : structuredModelFloor ?? proseModelFloor;
  if (requestedModel) model = maxTier(model, requestedModel);

  let reasoningEffort: CodexReasoningEffort;
  if (model === "luna") {
    reasoningEffort = workType === "research"
      ? uncertainty === "high" ? "high" : "medium"
      : workType === "verification" && complexity === "bounded" && uncertainty === "low"
        ? "low"
        : "medium";
  } else if (model === "terra") {
    reasoningEffort = complexity === "intense"
      || (crossProject && expectedDuration === "long")
      || (workType === "architecture" && expectedDuration === "long")
      ? "ultra"
      : "xhigh";
  } else {
    reasoningEffort = explicitSolMax || requiresSolMax ? "max" : "xhigh";
  }
  const structuredEffortFloor = parseCodexReasoningEffort(input.requestedReasoningEffort);
  const requestedEffort = structuredEffortFloor && proseEffortFloor
    ? maxEffort(structuredEffortFloor, proseEffortFloor)
    : structuredEffortFloor ?? proseEffortFloor;
  if (requestedEffort) reasoningEffort = maxEffort(reasoningEffort, requestedEffort);
  // Critical production/security/privacy work is one of the exceptional
  // situations where the safety route intentionally selects Sol/max even if
  // a prior caller carried the incomparable Terra/ultra preference.
  if (requiresSolMax) reasoningEffort = "max";

  const lead = selectionLead({
    task, workType, complexity, productionRisk, expectedDuration, crossProject, explicitQuality, model,
  });
  const requestedFloor = requestedModel || requestedEffort
    ? `; requested ${requestedModel ? workModelLabel(requestedModel) : "tier"}/${requestedEffort ?? "default"} floor`
    : "";
  const modelReason = (
    `${lead}; ${complexity} complexity, ${uncertainty} uncertainty, ${productionRisk} production risk, `
    + `${expectedDuration} duration, ${toolBreadth} tools${crossProject ? ", cross-project" : ""}; ${role}${requestedFloor}`
  ).slice(0, 300);

  return {
    model,
    reasoningEffort,
    modelReason,
    workType,
    complexity,
    uncertainty,
    productionRisk,
    expectedDuration,
    toolBreadth,
    crossProject,
  };
}

/** Preserve retries exactly unless two explicit quality failures justify one step up. */
export function selectCodexRetryPolicy(input: {
  model: unknown;
  reasoningEffort: unknown;
  modelReason: unknown;
  qualityFailureCount: number;
  evidence?: unknown;
}): CodexRetrySelection {
  const model = normalizeWorkModelTier(input.model);
  const fallbackEffort: CodexReasoningEffort = model === "luna" ? "medium" : "xhigh";
  const reasoningEffort = normalizeCodexReasoningEffort(input.reasoningEffort, fallbackEffort);
  const modelReason = boundedText(input.modelReason, 300) || "Persisted adaptive Codex route";
  const qualityFailureCount = Math.max(0, Math.floor(input.qualityFailureCount));
  if (qualityFailureCount < 2 || model === "sol") {
    return { model, reasoningEffort, modelReason, escalated: false };
  }
  const escalatedModel: WorkModelTier = model === "terra" && reasoningEffort === "ultra" && qualityFailureCount >= 4
    ? "sol"
    : "terra";
  const escalatedEffort: CodexReasoningEffort = escalatedModel === "sol"
    ? "max"
    : model === "luna"
      ? "xhigh"
      : "ultra";
  if (escalatedModel === model && escalatedEffort === reasoningEffort) {
    return { model, reasoningEffort, modelReason, escalated: false };
  }
  const evidence = boundedText(input.evidence, 100) || "repeated supervisor-evidenced quality gaps";
  return {
    model: escalatedModel,
    // After separately evidenced Terra/ultra failures, the exceptional
    // Sol/max route is deliberate—not an accidental comparison of unlike
    // "ultra" delegation and single-agent reasoning labels.
    reasoningEffort: escalatedEffort,
    modelReason: (
      `Escalated ${workModelLabel(model)}/${reasoningEffort} to ${workModelLabel(escalatedModel)}/${escalatedEffort} `
      + `after ${qualityFailureCount} evidenced quality failures: ${evidence}. Prior: ${modelReason}`
    ).slice(0, 300),
    escalated: true,
  };
}
