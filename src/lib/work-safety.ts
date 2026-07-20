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

// In repository prose, these hyphenated forms use "post-" to mean "after".
// Keep the allowlist technical and exact so "post the findings" remains an
// external publication action.
const TECHNICAL_TEMPORAL_POST_PREFIX =
  /^-(?:index(?:ed|ing)?(?:-stage)?|merge)\b/i;

// A delivery controller can move its review prompt to a local child process
// through standard input. These patterns describe the object and transport,
// not merely co-occurring technical words, so a direct or named recipient
// cannot borrow the exception.
const CONTROLLER_REVIEW_PROMPT_OBJECT =
  /^(?:(?:the|a|an|this|that)\s+)?(?:(?:final|generated|full|large|long|sol|max|codex)\s+)*(?:(?:(?:delivery[- ]?)?controller|reviewer)(?:['’]s)?[- ]+(?:review[- ]+)?|review[- ]+)prompt\b/i;

const STANDARD_INPUT_AFTER_PROMPT =
  /^\s+(?:through|via|over|on|into|using)\s+(?:the\s+)?(?:standard[- ]input|stdin)\b/i;

const STANDARD_INPUT_SEND_LEAD =
  /(?:\b(?:standard[- ]input|stdin)\s+to|(?:through|via|over|on|into|using)\s+(?:the\s+)?(?:standard[- ]input|stdin)\s*,?)\s*$/i;

const NON_TECHNICAL_TRANSFER_TAIL =
  /\b(?:email|message|reply|contact|cc|copy|publicly|externally)\b|\b(?:to|for)\s+(?!(?:avoid|prevent|remove|keep|reduce|handle|support|fix|eliminate|review|the\s+(?:controller|codex|process|runner)|(?:controller|codex|process|runner))\b)/i;

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

const REPORTED_CONVERSATION_CONTEXT =
  /(?:\b(?:response|answer|output|result|transcript|turn|input|prompt|request|instruction|command)\b[^;\n]{0,160}\b(?:was|were|is|are|said|read|returned|produced|contained|showed)\b|\b(?:the\s+)?(?:first|second|third|next|previous|prior|former|latter)(?:\s+(?:response|answer|output|result|turn|one))?\s+(?:was|were|is|are)\b)[^;\n]{0,240}$/i;

const NOMINAL_COMMUNICATION_TAIL =
  /^(?:['’]s\s+)?(?:association|body|content|correctness|event|handler|handling|id|latency|ordering|parser|payload|protocol|schema|state|status|stream|text|timing|trace|turn)\b/i;

const NOMINAL_COMMUNICATION_LEAD =
  /\b(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their|first|second|third|last|previous|next|incoming|outgoing|assistant|user|chat|foreground|model|synthetic|customer|tenant|parent)\s*$/i;

const COMMUNICATION_DETERMINER_LEAD =
  /\b(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their)\s*$/i;

// A determiner makes "message" / "reply" a noun in clauses such as "a
// message arriving during handoff". Limit the extra grammar to present
// participles; direct imperatives such as "message arriving passengers" have
// no determiner and still reach the consequential gate.
const NOMINAL_COMMUNICATION_PARTICIPIAL_TAIL =
  /^[a-z]+ing\b/i;

const PASSIVE_EXTERNAL_COMMUNICATION =
  /\b(?:sent|emailed|messaged|replied|contacted|published|posted|advertised)\b/i;

const NOMINAL_COMMUNICATION_AFTER_LEAD =
  /^(?:['’]s\b|(?:to|from|was|were|is|are|has|had|text|content|body|payload|event|turn)\b|$)/i;

function quoteCloser(task: string, index: number): string | null {
  const character = task[index];
  if (character === "\"") return "\"";
  if (character === "“") return "”";
  if (character === "‘") return "’";
  if (character !== "'") return null;
  const previous = task[index - 1] ?? "";
  const next = task[index + 1] ?? "";
  return !/[a-z0-9]/i.test(previous) && /\S/.test(next) ? "'" : null;
}

function closesQuote(task: string, index: number, closer: string): boolean {
  if (task[index] !== closer) return false;
  if (closer === "'" && /[a-z0-9]/i.test(task[index - 1] ?? "") && /[a-z0-9]/i.test(task[index + 1] ?? "")) {
    return false;
  }
  let escapes = 0;
  for (let cursor = index - 1; cursor >= 0 && task[cursor] === "\\"; cursor -= 1) escapes += 1;
  return escapes % 2 === 0;
}

function hasClosingQuote(task: string, openingIndex: number, closer: string): boolean {
  for (let index = openingIndex + 1; index < task.length; index += 1) {
    if (closesQuote(task, index, closer)) return true;
  }
  return false;
}

function cleanClause(value: string): string {
  return value.trim().replace(/^[-*•]+\s*/, "");
}

function clauses(task: string): string[] {
  const result: string[] = [];
  let current = "";
  let closingQuote: string | null = null;

  const finish = () => {
    const clause = cleanClause(current);
    if (clause) result.push(clause);
    current = "";
  };

  for (let index = 0; index < task.length; index += 1) {
    const character = task[index];
    if (closingQuote) {
      current += character;
      if (closesQuote(task, index, closingQuote)) closingQuote = null;
      continue;
    }

    const closer = quoteCloser(task, index);
    if (closer && hasClosingQuote(task, index, closer)) {
      closingQuote = closer;
      current += character;
      continue;
    }

    if (character === "\n" || character === "\r" || /[.;!?]/.test(character)) {
      finish();
      if (character === "\r" && task[index + 1] === "\n") index += 1;
      continue;
    }

    const previous = task[index - 1] ?? "";
    if (!/[a-z0-9_]/i.test(previous)) {
      const conjunction = task.slice(index).match(/^(?:and\s+instead|and\s+then|then|but|and)\b/i);
      if (conjunction) {
        const clause = cleanClause(current);
        const contrast = /^(?:but|and\s+instead)$/i.test(conjunction[0]);
        // A leading prohibition scopes over coordinated verbs: “do not send
        // and publish” prohibits both. Positive clauses still split here so
        // “research and purchase” cannot borrow the read-only lead.
        if (!contrast && (NEGATED_LEAD.test(clause) || NEGATED_TAIL.test(clause))) {
          current += ` ${conjunction[0]} `;
        } else {
          finish();
        }
        index += conjunction[0].length - 1;
        continue;
      }
    }

    current += character;
  }
  finish();
  return result;
}

function quotedActionContext(clause: string, actionIndex: number): string | null {
  let closingQuote: string | null = null;
  let openingIndex = -1;
  for (let index = 0; index < clause.length; index += 1) {
    if (closingQuote) {
      if (!closesQuote(clause, index, closingQuote)) continue;
      if (openingIndex < actionIndex && actionIndex < index) {
        return clause.slice(0, openingIndex).trim();
      }
      closingQuote = null;
      openingIndex = -1;
      continue;
    }
    const closer = quoteCloser(clause, index);
    if (!closer || !hasClosingQuote(clause, index, closer)) continue;
    closingQuote = closer;
    openingIndex = index;
  }
  return null;
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

function controllerReviewStdinTransfer(clause: string, before: string, after: string): boolean {
  if (!/\b(?:standard[- ]input|stdin)\b/i.test(clause)) return false;
  const prompt = after.match(CONTROLLER_REVIEW_PROMPT_OBJECT);
  if (!prompt) return false;
  const afterPrompt = after.slice(prompt[0].length);
  const transport = afterPrompt.match(STANDARD_INPUT_AFTER_PROMPT);
  const tail = transport
    ? afterPrompt.slice(transport[0].length)
    : STANDARD_INPUT_SEND_LEAD.test(before)
      ? afterPrompt
      : null;
  return tail !== null && !NON_TECHNICAL_TRANSFER_TAIL.test(tail);
}

// "Order" is also a pervasive commerce data noun (order pipeline, Shopify
// order, order/fulfillment). Treat it as an action only in an imperative or
// after an explicit placement verb; the other money verbs remain conservative.
function consequentialUse(action: string, clause: string, actionIndex: number): boolean {
  const normalized = action.toLocaleLowerCase("en-GB");
  const before = clause.slice(0, actionIndex).trim();
  const after = clause.slice(actionIndex + action.length).trim();
  if (/^(?:message|reply)$/i.test(normalized)) {
    // Chat engineering prompts use these words as data nouns (“reply
    // latency”, “message event”). An actual imperative has no determiner, and
    // consequential companion verbs such as “send a reply” are matched on
    // their own before this nominal occurrence can be ignored.
    if (
      NOMINAL_COMMUNICATION_LEAD.test(before)
      && (NOMINAL_COMMUNICATION_TAIL.test(after) || NOMINAL_COMMUNICATION_AFTER_LEAD.test(after))
    ) return false;
    if (
      COMMUNICATION_DETERMINER_LEAD.test(before)
      && NOMINAL_COMMUNICATION_PARTICIPIAL_TAIL.test(after)
      && !PASSIVE_EXTERNAL_COMMUNICATION.test(after)
    ) return false;
  }
  if (normalized === "send") {
    if (controllerReviewStdinTransfer(clause, before, after)) return false;
  }
  if (normalized === "post") {
    if (TECHNICAL_TEMPORAL_POST_PREFIX.test(after)) return false;
  }
  if (normalized === "message") {
    // Repository instructions routinely describe a git commit message, while
    // the consequential meaning is an instruction to message a person. The
    // conjunction splitter keeps "commit this and message the tenant" in a
    // separate clause, so this narrow nominal-use exception cannot waive the
    // external action.
    if (/\bcommit\b[^.;!?\n]{0,80}$/i.test(before) && /^(?:starting|prefix(?:ed)?|format(?:ted)?|must\s+(?:start|begin)|should\s+(?:start|begin)|:)/i.test(after)) return false;
    if (/\b(?:error|status|progress|validation|log)\s*$/i.test(before)) return false;
  }
  if (normalized !== "order") return true;
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
      const quoteContext = quotedActionContext(clause, actionIndex);
      if (quoteContext !== null && REPORTED_CONVERSATION_CONTEXT.test(quoteContext)) continue;
      if (NEGATED_LEAD.test(clause)) continue;

      const beforeAction = clause.slice(0, actionIndex);
      if (NEGATED_TAIL.test(beforeAction)) continue;
      if (REPORTED_ACTION_TAIL.test(beforeAction)) continue;

      // "Audit whether X can send" describes a read-only outcome. A mixed
      // instruction such as "research options and purchase one" is split at
      // the conjunction, so its purchase clause still reaches the gate.
      if (quoteContext === null && NON_MUTATING_LEAD.test(clause)) continue;
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
