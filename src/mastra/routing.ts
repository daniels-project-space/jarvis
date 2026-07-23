import type { AgentSlug, ModelTier, WorkRisk } from "./team";
import { isOwnedRepository, requestsConsequentialAction } from "../lib/work-safety";
import {
  selectCodexWorkPolicy,
  type CodexReasoningEffort,
} from "../lib/codex-work-router";

export type WorkRoute = {
  agentId: AgentSlug;
  model: ModelTier;
  reasoningEffort: CodexReasoningEffort;
  modelReason: string;
  risk: WorkRisk;
  readonly: boolean;
  approvalRequired: boolean;
  priority: number;
  reason: string;
};

const engineering =
  /\b(code|repo|bug|fix|build|implement|refactor|migrat|database|api|deploy|typescript|react|next\.?js|convex|trigger|mastra|test|ci|architecture)\b/i;
const operations = /\b(incident|monitor|health|uptime|failed job|stalled|latency|cost|credits|logs?|provider status|production issue)\b/i;
const creative = /\b(draw|illustrat|image|visual|diagram|mind ?map|storyboard|brand|design|poster|thumbnail|creative)\b/i;
const travel = /\b(travel|trip|flight|hotel|stay|itinerary|airport|destination|holiday|booking\.com)\b/i;
const research = /\b(research|compare|analyse|analyze|strategy|brainstorm|investigate|audit|learn|find out|market|competitor)\b/i;
const complex = /\b(architecture|root cause|multi[- ]?(repo|project|file)|migration|redesign|overhaul|security|performance|production|end[- ]to[- ]end)\b/i;

export function routeWork(task: string, options?: {
  repo?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  readonly?: boolean;
  tools?: readonly unknown[];
  role?: AgentSlug;
}): WorkRoute {
  const text = `${task} ${options?.repo ?? ""}`.trim();
  const repoOutsidePortfolio = Boolean(options?.repo && options.readonly !== true && !isOwnedRepository(options.repo));
  const isConsequential = repoOutsidePortfolio || requestsConsequentialAction(task, { repo: options?.repo });
  let agentId: AgentSlug = "atlas";
  if (travel.test(text)) agentId = "maya";
  else if (creative.test(text)) agentId = "iris";
  else if (operations.test(text)) agentId = "sentry";
  else if (engineering.test(text) || options?.repo) agentId = "paul";
  else if (research.test(text)) agentId = "atlas";

  const hard = complex.test(text) || (engineering.test(text) && text.length > 500);
  const readonly = options?.readonly ?? (agentId === "atlas" || isConsequential);
  const risk: WorkRisk = isConsequential ? "consequential" : hard ? "high" : agentId === "paul" ? "medium" : "low";
  const approvalRequired = isConsequential;
  const policy = selectCodexWorkPolicy({
    task,
    role: options?.role ?? agentId,
    repo: options?.repo,
    readonly,
    risk,
    tools: options?.tools,
    requestedModel: options?.requestedModel,
    requestedReasoningEffort: options?.requestedReasoningEffort,
  });
  const priority = Math.min(100, 45 + (hard ? 25 : 0) + (isConsequential ? 20 : 0) + (operations.test(text) ? 10 : 0));
  const reason = `${agentId} matches ${agentId === "paul" ? "engineering" : agentId === "maya" ? "travel" : agentId === "iris" ? "creative" : agentId === "sentry" ? "operations/review" : "research/strategy"}; ${policy.modelReason}${approvalRequired ? "; execution waits for explicit approval" : ""}`;
  return {
    agentId,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    modelReason: policy.modelReason,
    risk,
    readonly,
    approvalRequired,
    priority,
    reason,
  };
}

export function suggestedAcceptanceCriteria(task: string, route: WorkRoute): string[] {
  const criteria = ["Deliver the requested outcome with concrete evidence, not a progress-only report"];
  if (route.agentId === "paul") criteria.push("Inspect current callers and data before editing", "Run relevant typecheck/tests/build and report results");
  if (route.agentId === "atlas") criteria.push("Use current primary sources and distinguish facts from inference");
  if (route.agentId === "iris") criteria.push("Produce an editable asset or production-ready visual brief, not only prose");
  if (route.agentId === "maya") criteria.push("Show provider status, checked time, assumptions, and projected versus locked totals");
  if (route.agentId === "sentry") criteria.push("Verify the actual provider or user-visible surface after any repair");
  if (/deploy|production/i.test(task)) criteria.push("Do not call it live until the production alias is verified");
  return criteria;
}
