import { isOwnedRepositoryScope } from "./workflow-contract";

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

const LIVE_PROVIDER_DEPLOYMENT_OBJECT =
  /^(?:(?:the|a|an|this|that)\s+)?(?:(?:live|production)\s+)?provider(?:\s+(?:change|configuration|resource|service|effect|deployment))?\b/i;

// Publication is public/consequential by default. The owned-repository
// exception is bound to the direct technical object of the verb; a Git word
// elsewhere in the clause cannot make "publish the findings" autonomous.
const REVIEWED_GIT_REF_PUBLICATION_OBJECT =
  /^(?:only\s+)?(?:to\s+|on\s+)?(?:(?:the|a|an|this|that|its)\s+)?(?:(?:reviewed|verified|accepted|approved|signed)\s+(?:(?:git\s+)(?:(?:worker|integration|delivery)\s+)?(?:branch|ref)|(?:worker|integration|delivery)\s+(?:branch|ref))|git\s+(?:(?:worker|integration|delivery)\s+)?(?:branch|ref))\b/i;

const TECHNICAL_PROVIDER_PUBLICATION_OBJECT =
  /^(?:only\s+)?(?:(?:the|a|an|this|that|its)\s+)?(?:convex\s+(?:functions?|schema|migration)|trigger(?:\.dev)?\s+(?:tasks?|build)|vercel\s+(?:build|deployment))\b/i;

const NON_REPOSITORY_PUBLICATION_CONTEXT =
  /\b(?:public|publicly|external|externally|social|content|findings|report|article|blog|website|internet|forum|feed|channel|audience|users?|advert(?:isement|ising)?|ads?|package|npm|registry|store|marketplace|newsletter|press|customer|tenant)\b/i;

// In repository prose, these hyphenated forms use "post-" to mean "after".
// Keep the allowlist technical and exact so "post the findings" remains an
// external publication action.
const TECHNICAL_TEMPORAL_POST_PREFIX =
  /^-(?:create(?:d|ion)?|index(?:ed|ing)?(?:-stage)?|merge)\b/i;

// Uppercase POST is an HTTP/provider-method noun only when either its direct
// left-hand qualifier or its direct path-shaped object makes that grammar
// unambiguous. Lowercase/title-case "post" never borrows this exception.
const HTTP_POST_NOMINAL_LEAD =
  /\b(?:https?|api|rest|graphql|provider[-_ ]method|stage_(?:blob|tree|commit)|update_ref|response[-_ ]lost|request[-_ ]lost)\s*$/i;

const HTTP_POST_NOMINAL_TAIL =
  /^(?:$|\/[^\s]*|(?:(?:may|might|could|can|should|would|will|must)\s+have\s+(?:applied|failed|returned)|request|method|call|operation|effect|response|receipt|evidence|idempotency|failure|result|status|body|payload|headers?|endpoint|whose|that|which|was|were|is|are|has|had|with|without|before|after|during|from|to|against)\b)/i;

// These exact hyphenated/slash-separated forms are descriptive cloud-sandbox
// vocabulary. Keep the exception at the matched token boundary: the ordinary
// verbs ("email the user", "pay the provider", and so on) remain gated.
const TECHNICAL_COMPOUND_TAIL: Partial<Record<string, RegExp>> = {
  email: /^-verified\b/i,
  message: /^-queue\b/i,
  pay: /^-as-you-go\b/i,
};

const TECHNICAL_DELETE_COMPOUND_LEAD = /\bauto-stop\/archive\/$/i;

const TECHNICAL_DELETE_COMPOUND_TAIL =
  /^(?:$|,\s*snapshot\s+identity(?=\s*(?:,|$))|(?:as|for|in|within)\b|(?:sandbox|resource|lifecycle|retention|cleanup|policy|policies|controls?|states?|transitions?|semantics|settings?|configuration|options?|behavio(?:u)?r|support|workflow|handling)\b)/i;

// A lifecycle test can describe the exact-name recovery branch as “If it
// exists, exact-name delete it”. This is deliberately not a general sandbox
// exception: it requires an explicit non-resuming SDK lookup and the
// generated-name/pronoun grammar. “Delete the production sandbox”, a data
// object, and a live-provider target all retain a non-matching tail.
const EXACT_NAME_DELETE_OBJECT = /^(?:it|the\s+(?:exact\s+)?sandbox)\s*$/i;

const EXACT_NAME_RECOVERY_DELETE_LEAD = /\bif\s+it\s+exists,\s+exact[- ]name\s*$/i;

const NON_RESUMING_SANDBOX_LOOKUP =
  /\bSandbox\.get\s*\([^)]*\bresume\s*:\s*false[^)]*\)/i;

// “a failed final delete remains un-terminated in Convex” names one exact
// lifecycle state rather than ordering a deletion. Keep the complete noun
// grammar bounded: a data object or scheduled future effect must not borrow a
// lifecycle word elsewhere in the clause.
const TECHNICAL_LIFECYCLE_DELETE_NOUN_LEAD =
  /\b(?:a|the)\s+failed\s+final\s*$/i;

const TECHNICAL_LIFECYCLE_DELETE_NOUN_TAIL =
  /^remains\s+un-terminated\s+in\s+Convex\s*$/i;

const TECHNICAL_TEST_MATRIX_DELETE_LEAD =
  /\b(?:get|create|terminate|delete)\s+and\s*$/i;

const TECHNICAL_TEST_MATRIX_CONJUNCTION_LEAD =
  /^\s*tests?(?:ing)?\b/i;

// Root review is a controller-internal Git-ref handoff. The otherwise vague
// object "a reviewed ref" is accepted only with both this direct object/tail
// and a trusted controller as the publishing subject.
const ROOT_REVIEWED_REF_PUBLICATION_OBJECT =
  /^(?:a|the)\s+reviewed\s+(?:git\s+)?ref\s+for\s+root\s+review\b/i;

const TRUSTED_CONTROLLER_PUBLICATION_LEAD =
  /\b(?:the\s+)?trusted\s+(?:(?:delivery|integration)\s+)?controller\b[^.;!?\n]{0,80}\b(?:may|might|can|could|should|would|will|must|to)\s*$/i;

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

// A read-only lead describes a consequential verb only when that particular
// occurrence is inside analytical grammar. It must not waive a later direct
// instruction merely because both happen to share a comma, colon, or dash.
const ANALYTICAL_ACTION_SCOPE_BOUNDARY = /[,:–—]/g;

const ANALYTICAL_RELATIVE_ACTION_SCOPE =
  /^(?:(?:please\s+)?(?:research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b[^,:–—]*\b)?(?:that|which|where|how)\b[^,:–—]*?(?:(?:can|could|may|might|would|will|does|do)\s+)?$/i;

const ANALYTICAL_NOMINAL_ACTION_SCOPE =
  /^(?:please\s+)?(?:research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b[^,:–—]*\b(?:ability|capability|permission|path|trace)\b[^,:–—]*\bto\s*$/i;

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

    // Keep the member separator in SDK calls such as Sandbox.get intact. A
    // sentence terminator still wins for every other period.
    const sdkMemberSeparator =
      character === "."
      && /[a-z0-9_$]/i.test(task[index - 1] ?? "")
      && /[a-z_$]/i.test(task[index + 1] ?? "");
    // Preserve only the semicolon whose complete immediate right-hand clause
    // is the exact simulated recovery branch. This carries the non-resuming
    // lookup into “if it exists, exact-name delete it” without merging any
    // independent instruction that follows it.
    const simulatedSandboxRecoverySeparator =
      character === ";"
      && NON_RESUMING_SANDBOX_LOOKUP.test(current)
      && /^;\s*if\s+it\s+exists,\s+exact[- ]name\s+delete\s+it\s*(?=$|[.;!?\r\n]|(?:and\s+instead|and\s+then|then|but|and)\b)/i.test(task.slice(index));
    if (!sdkMemberSeparator && !simulatedSandboxRecoverySeparator && (character === "\n" || character === "\r" || /[.;!?]/.test(character))) {
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
        if (!contrast && (
          NEGATED_LEAD.test(clause)
          || NEGATED_TAIL.test(clause)
          || TECHNICAL_TEST_MATRIX_CONJUNCTION_LEAD.test(clause)
        )) {
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

function analyticalActionContext(clause: string, actionIndex: number): string {
  const beforeAction = clause.slice(0, actionIndex);
  let boundary = -1;
  for (const match of beforeAction.matchAll(ANALYTICAL_ACTION_SCOPE_BOUNDARY)) {
    boundary = match.index ?? boundary;
  }
  return beforeAction.slice(boundary + 1).trim();
}

function analyticalActionUse(clause: string, actionIndex: number): boolean {
  const context = analyticalActionContext(clause, actionIndex);
  if (REPORTED_ACTION_TAIL.test(context)) return true;
  if (ANALYTICAL_RELATIVE_ACTION_SCOPE.test(context)) return true;
  return ANALYTICAL_NOMINAL_ACTION_SCOPE.test(context);
}

export function isOwnedRepository(repo: string | undefined): boolean {
  return isOwnedRepositoryScope(repo);
}

function softwareDeliveryAllowed(
  action: string,
  clause: string,
  repo: string | undefined,
  actionIndex: number,
): boolean {
  if (!isOwnedRepository(repo)) return false;
  const after = clause.slice(actionIndex + action.length).replace(/[`*]/g, "").trim();
  if (action.toLocaleLowerCase("en-GB") === "deploy" && LIVE_PROVIDER_DEPLOYMENT_OBJECT.test(after)) {
    return false;
  }
  if (SOFTWARE_DELIVERY_ACTION.test(action)) return true;
  if (action.toLocaleLowerCase("en-GB") !== "publish") return false;
  // Markdown code/emphasis delimiters do not change the grammatical object.
  const before = clause.slice(0, actionIndex).replace(/[`*]/g, "").trim();
  const controllerRootReview =
    ROOT_REVIEWED_REF_PUBLICATION_OBJECT.test(after)
    && TRUSTED_CONTROLLER_PUBLICATION_LEAD.test(before);
  if (
    !controllerRootReview
    && !REVIEWED_GIT_REF_PUBLICATION_OBJECT.test(after)
    && !TECHNICAL_PROVIDER_PUBLICATION_OBJECT.test(after)
  ) {
    return false;
  }
  return !NON_REPOSITORY_PUBLICATION_CONTEXT.test(clause);
}

function technicalHttpPostUse(action: string, before: string, after: string): boolean {
  if (action !== "POST") return false;
  const technicalBefore = before.replace(/[`*]/g, "").trim();
  const technicalAfter = after.replace(/[`*]/g, "").trim();
  if (/^\/[^\s]*/.test(technicalAfter)) return true;
  return HTTP_POST_NOMINAL_LEAD.test(technicalBefore) && HTTP_POST_NOMINAL_TAIL.test(technicalAfter);
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
  const unformattedBefore = before.replace(/[`*]/g, "").trim();
  const technicalCompoundTail = TECHNICAL_COMPOUND_TAIL[normalized];
  if (technicalCompoundTail?.test(after)) return false;
  if (
    normalized === "delete"
    && TECHNICAL_DELETE_COMPOUND_LEAD.test(before)
    && TECHNICAL_DELETE_COMPOUND_TAIL.test(after)
  ) return false;
  if (normalized === "delete") {
    if (
      EXACT_NAME_DELETE_OBJECT.test(after)
      && EXACT_NAME_RECOVERY_DELETE_LEAD.test(unformattedBefore)
      && NON_RESUMING_SANDBOX_LOOKUP.test(clause)
    ) return false;
    if (
      TECHNICAL_LIFECYCLE_DELETE_NOUN_LEAD.test(unformattedBefore)
      && TECHNICAL_LIFECYCLE_DELETE_NOUN_TAIL.test(after)
    ) return false;
    if (
      TECHNICAL_TEST_MATRIX_DELETE_LEAD.test(unformattedBefore)
      && /\btest(?:s|ing)?\b/i.test(clause)
      && /^(?:$|(?:for|with|against)\b)/i.test(after)
    ) return false;
  }
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
    if (technicalHttpPostUse(action, before, after)) return false;
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
  return /\b(?:place|submit|make|create|buy|purchase|pay(?:\s+for)?|want\s+(?:you|jarvis)\s+to|need\s+(?:you|jarvis)?\s*to)\s+(?:(?:a|an|the|this|that|one|real|test|customer|supplier)(?:\s+|$))*$/i.test(before);
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
      if (analyticalActionUse(clause, actionIndex)) continue;

      // "Audit whether X can send" describes a read-only outcome. A mixed
      // instruction such as "research options and purchase one" is split at
      // the conjunction, so its purchase clause still reaches the gate.
      // “Test delete customer records” is still an instruction to delete;
      // test matrices rely on the exact technical noun grammar above rather
      // than a broad test-verb waiver.
      if (softwareDeliveryAllowed(action, clause, options?.repo, actionIndex)) {
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
    if (NEGATED_LEAD.test(clause)) return false;
    if (match && NEGATED_TAIL.test(clause.slice(0, match.index ?? 0))) return false;
    return Boolean(match && softwareDeliveryAllowed(match[0], clause, options?.repo, match.index));
  });
  return {
    approvalRequired: false,
    boundary: asksForSoftwareDelivery ? "software_delivery" : "internal",
  };
}

export function requestsConsequentialAction(task: string, options?: { repo?: string }): boolean {
  return classifyWorkSafety(task, options).approvalRequired;
}
