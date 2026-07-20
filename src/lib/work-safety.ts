/**
 * Text-level backstop for consequential work.
 *
 * The supervisor supplies structured risk, but a caller-controlled `readonly`
 * flag must never be able to erase an explicit request to message, publish,
 * spend, or destroy. At the same time, audit prompts routinely mention
 * those verbs inside prohibitions ("do not deploy") or analysis clauses
 * ("verify whether a worker can send"). Clause-aware classification keeps the
 * boundary conservative without turning every security review into an approval.
 */

export const CONSEQUENTIAL_ACTION =
  /\b(send|email|message|reply|contact|publish|post|advertis(?:e|ing)|deploy|merge|book|reserve|buy|purchase|order|pay|spend|transfer|trade|withdraw|refund|charge|invoice|delete|destroy|drop|truncate|rotate (?:a )?(?:key|secret)|change (?:a )?(?:password|credential)|cancel (?:a )?(?:booking|subscription|account))\b/i;

export const SAFE_SANDBOX_EXECUTION_RULES =
  "When the task or its acceptance criteria explicitly require provider sandbox/test-mode validation, an isolated non-billable test artifact is already authorized if it cannot pay or charge, message anyone, publish publicly, reserve real inventory, create a real supplier/customer order, or start fulfillment. Do not ask Daniel to approve that bounded test again. This never authorizes live-effect flags, credential changes, real commerce, outreach, publication, or spend. A specialist without scoped test credentials must preserve the safe controller handoff instead of requesting broader credentials or pretending the provider trace ran.";

const SOFTWARE_DELIVERY_ACTION = /^(?:deploy|merge)$/i;
const TECHNICAL_PUBLICATION =
  /\b(?:convex|trigger(?:\.dev)?|vercel|function|schema|migration|build|release|deployment)\b/i;

export type WorkSafetyBoundary = "internal" | "software_delivery" | "external";

export type WorkSafetyDecision = {
  approvalRequired: boolean;
  boundary: WorkSafetyBoundary;
  reason?: string;
};

const NON_MUTATING_LEAD =
  /^(?:please\s+)?(?:research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b/i;

const NEGATED_LEAD =
  /^(?:do\s+not|don't|never|must\s+not|should\s+not|may\s+not|cannot|can't|without|avoid|forbid(?:den)?|prohibit(?:ed)?|no\b)/i;

const NEGATED_TAIL =
  /\b(?:do\s+not|don't|never|must\s+not|should\s+not|may\s+not|cannot|can't|without|avoid|no)\b[^.;!?\n]{0,160}$/i;

// Security reviews often include past-tense evidence such as “the job asked
// to send a reply”. That is a description of the tested instruction, not a
// fresh imperative. Keep this narrow: a bare “Evidence: send the reply” still
// reaches the consequential gate.
const REPORTED_ACTION_TAIL =
  /\b(?:asked|attempted|tried|claimed|reported|observed|showed|demonstrated|proved|tested|verified|blocked|prevented|allowed|denied|whether)\b[^.;!?\n]{0,160}$/i;

function clauses(task: string): string[] {
  return task
    .split(/\r?\n|[.;!?]+|\b(?:and\s+then|then|and)\b/gi)
    .map((part) => part.trim().replace(/^[-*•]+\s*/, ""))
    .filter(Boolean);
}

export function isOwnedRepository(repo: string | undefined): boolean {
  const raw = String(repo ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!raw) return false;
  if (!raw.includes("/")) return /^[a-z0-9][a-z0-9._-]*$/i.test(raw);
  const [owner, name, ...rest] = raw.split("/");
  return rest.length === 0
    && owner.toLocaleLowerCase("en-GB") === "daniels-project-space"
    && /^[a-z0-9][a-z0-9._-]*$/i.test(name ?? "");
}

function softwareDeliveryAllowed(action: string, clause: string, repo: string | undefined): boolean {
  if (!isOwnedRepository(repo)) return false;
  if (SOFTWARE_DELIVERY_ACTION.test(action)) return true;
  // "Publish" is normally a public/content action. In a scoped Daniel-owned
  // repository, narrowly technical publication such as Convex functions is
  // software delivery; publishing a post, advert or package remains gated.
  return action.toLocaleLowerCase("en-GB") === "publish" && TECHNICAL_PUBLICATION.test(clause);
}

// "Order" is also a pervasive commerce data noun (order pipeline, Shopify
// order, order/fulfillment). Treat it as an action only in an imperative or
// after an explicit placement verb; the other money verbs remain conservative.
function consequentialUse(action: string, clause: string, actionIndex: number): boolean {
  const normalized = action.toLocaleLowerCase("en-GB");
  if (normalized === "message") {
    const before = clause.slice(0, actionIndex).trim();
    const after = clause.slice(actionIndex + action.length).trim();
    // Repository instructions routinely describe a git commit message, while
    // the consequential meaning is an instruction to message a person. The
    // conjunction splitter keeps "commit this and message the tenant" in a
    // separate clause, so this narrow nominal-use exception cannot waive the
    // external action.
    if (/\bcommit\b[^.;!?\n]{0,80}$/i.test(before) && /^(?:starting|prefix(?:ed)?|format(?:ted)?|must\s+(?:start|begin)|should\s+(?:start|begin)|:)/i.test(after)) return false;
    if (/\b(?:error|status|progress|validation|log)\s*$/i.test(before)) return false;
  }
  if (normalized !== "order") return true;
  const before = clause.slice(0, actionIndex).trim();
  if (/^(?:(?:please|can you|could you|would you)\s*)?$/i.test(before)) return true;
  return /\b(?:place|submit|make|create|buy|purchase|pay(?:\s+for)?|want\s+(?:you|jarvis)\s+to|need\s+(?:you|jarvis)?\s*to)\s+(?:(?:a|an|the|this|that|one|real)\s+)*$/i.test(before);
}

export function classifyWorkSafety(
  task: string,
  options?: { repo?: string },
): WorkSafetyDecision {
  for (const clause of clauses(task)) {
    const matcher = new RegExp(CONSEQUENTIAL_ACTION.source, "gi");
    for (const match of clause.matchAll(matcher)) {
      const action = match[0];
      const actionIndex = match.index ?? 0;
      if (!consequentialUse(action, clause, actionIndex)) continue;
      if (NEGATED_LEAD.test(clause)) continue;

      const beforeAction = clause.slice(0, actionIndex);
      if (NEGATED_TAIL.test(beforeAction)) continue;
      if (REPORTED_ACTION_TAIL.test(beforeAction)) continue;

      // "Audit whether X can send" describes a read-only outcome. A mixed
      // instruction such as "research options and purchase one" is split at
      // the conjunction, so its purchase clause still reaches the gate.
      if (NON_MUTATING_LEAD.test(clause)) continue;
      if (softwareDeliveryAllowed(action, clause, options?.repo)) {
        continue;
      }
      return {
        approvalRequired: true,
        boundary: "external",
        reason: "task requests an external, financial, public, credential, or destructive action",
      };
    }
  }
  const asksForSoftwareDelivery = clauses(task).some((clause) => {
    const match = CONSEQUENTIAL_ACTION.exec(clause);
    return Boolean(match && softwareDeliveryAllowed(match[0], clause, options?.repo));
  });
  return {
    approvalRequired: false,
    boundary: asksForSoftwareDelivery ? "software_delivery" : "internal",
  };
}

export function requestsConsequentialAction(task: string, options?: { repo?: string }): boolean {
  return classifyWorkSafety(task, options).approvalRequired;
}
