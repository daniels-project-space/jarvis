import type { AgentSlug, ModelTier, WorkRisk } from "./team";

export type WorkRoute = {
  agentId: AgentSlug;
  model: ModelTier;
  risk: WorkRisk;
  readonly: boolean;
  approvalRequired: boolean;
  priority: number;
  reason: string;
};

const consequential =
  /\b(send|email|contact|publish|post|advertis(?:e|ing)|book|reserve|buy|purchase|order|pay|spend|transfer|trade|withdraw|refund|charge|merge|delete production|destroy|drop (?:table|database)|truncate|rotate (?:a )?(?:key|secret)|change (?:a )?(?:password|credential)|message (?:a |the )?(?:customer|guest|tenant)|reply to (?:a |the )?(?:customer|guest|tenant)|deploy (?:to )?production)\b/i;
const engineering =
  /\b(code|repo|bug|fix|build|implement|refactor|migrat|database|api|deploy|typescript|react|next\.?js|convex|trigger|mastra|test|ci|architecture)\b/i;
const operations = /\b(incident|monitor|health|uptime|failed job|stalled|latency|cost|credits|logs?|provider status|production issue)\b/i;
const creative = /\b(draw|illustrat|image|visual|diagram|mind ?map|storyboard|brand|design|poster|thumbnail|creative)\b/i;
const travel = /\b(travel|trip|flight|hotel|stay|itinerary|airport|destination|holiday|booking\.com)\b/i;
const research = /\b(research|compare|analyse|analyze|strategy|brainstorm|investigate|audit|learn|find out|market|competitor)\b/i;
const complex = /\b(architecture|root cause|multi[- ]?(repo|project|file)|migration|redesign|overhaul|security|performance|production|end[- ]to[- ]end)\b/i;
const trivial = /\b(status|list|locate|read|summari[sz]e|quick check|one[- ]line|rename|copy)\b/i;

export function routeWork(task: string, options?: { repo?: string; requestedModel?: string; readonly?: boolean }): WorkRoute {
  const text = `${task} ${options?.repo ?? ""}`.trim();
  const isConsequential = options?.readonly === true ? false : consequential.test(text);
  let agentId: AgentSlug = "atlas";
  if (travel.test(text)) agentId = "maya";
  else if (creative.test(text)) agentId = "iris";
  else if (operations.test(text)) agentId = "sentry";
  else if (engineering.test(text) || options?.repo) agentId = "paul";
  else if (research.test(text)) agentId = "atlas";

  const hard = complex.test(text) || (engineering.test(text) && text.length > 500);
  const easy = text.length < 140 && trivial.test(text) && !isConsequential;
  let model: ModelTier = hard ? "opus" : easy ? "haiku" : "sonnet";
  if (["haiku", "sonnet", "opus"].includes(options?.requestedModel ?? "")) model = options!.requestedModel as ModelTier;
  // Never allow an explicit cheap tier to silently reduce high-risk or hard
  // engineering quality; Daniel's workspace standard prioritizes correctness.
  if ((hard || isConsequential) && model !== "opus") model = "opus";

  const readonly = options?.readonly ?? (agentId === "atlas" || isConsequential);
  const risk: WorkRisk = isConsequential ? "consequential" : hard ? "high" : agentId === "paul" ? "medium" : "low";
  const approvalRequired = isConsequential;
  const priority = Math.min(100, 45 + (hard ? 25 : 0) + (isConsequential ? 20 : 0) + (operations.test(text) ? 10 : 0));
  const reason = `${agentId} matches ${agentId === "paul" ? "engineering" : agentId === "maya" ? "travel" : agentId === "iris" ? "creative" : agentId === "sentry" ? "operations/review" : "research/strategy"}; ${model} selected for ${hard ? "complex" : easy ? "bounded" : "normal"} work${approvalRequired ? "; execution waits for explicit approval" : ""}`;
  return { agentId, model, risk, readonly, approvalRequired, priority, reason };
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
