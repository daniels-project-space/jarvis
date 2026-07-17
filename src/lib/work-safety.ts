/**
 * Text-level backstop for consequential work.
 *
 * The supervisor supplies structured risk, but a caller-controlled `readonly`
 * flag must never be able to erase an explicit request to message, publish,
 * spend, deploy, or destroy. At the same time, audit prompts routinely mention
 * those verbs inside prohibitions ("do not deploy") or analysis clauses
 * ("verify whether a worker can send"). Clause-aware classification keeps the
 * boundary conservative without turning every security review into an approval.
 */

export const CONSEQUENTIAL_ACTION =
  /\b(send|email|message|reply|contact|publish|post|advertis(?:e|ing)|deploy|merge|book|reserve|buy|purchase|order|pay|spend|transfer|trade|withdraw|refund|charge|invoice|delete|destroy|drop|truncate|rotate (?:a )?(?:key|secret)|change (?:a )?(?:password|credential)|cancel (?:a )?(?:booking|subscription|account))\b/i;

const NON_MUTATING_LEAD =
  /^(?:please\s+)?(?:research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b/i;

const NEGATED_LEAD =
  /^(?:do\s+not|don't|never|must\s+not|should\s+not|may\s+not|cannot|can't|without|avoid|forbid(?:den)?|prohibit(?:ed)?|no\b)/i;

const NEGATED_TAIL =
  /\b(?:do\s+not|don't|never|must\s+not|should\s+not|may\s+not|cannot|can't|without|avoid)\b[^.;!?\n]{0,160}$/i;

function clauses(task: string): string[] {
  return task
    .split(/\r?\n|[.;!?]+|\b(?:and\s+then|then|and)\b/gi)
    .map((part) => part.trim().replace(/^[-*•]+\s*/, ""))
    .filter(Boolean);
}

export function requestsConsequentialAction(task: string): boolean {
  for (const clause of clauses(task)) {
    const match = CONSEQUENTIAL_ACTION.exec(clause);
    if (!match) continue;
    if (NEGATED_LEAD.test(clause)) continue;

    const beforeAction = clause.slice(0, match.index);
    if (NEGATED_TAIL.test(beforeAction)) continue;

    // "Audit whether X can send" describes a read-only outcome. A mixed
    // instruction such as "research options and purchase one" is split at the
    // conjunction, so its purchase clause still reaches the gate.
    if (NON_MUTATING_LEAD.test(clause)) continue;
    return true;
  }
  return false;
}
