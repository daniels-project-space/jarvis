export type WorkApprovalInput = {
  task: string;
  repo?: string;
  readonly?: boolean;
  risk?: string;
  approvalRequired?: boolean;
};

const CONSEQUENTIAL_ACTION =
  /\b(send|email|message|reply|contact|publish|post|advertis(?:e|ing)|deploy|merge|book|reserve|buy|purchase|order|pay|spend|transfer|trade|withdraw|refund|charge|invoice|delete|destroy|drop|truncate|rotate (?:a )?(?:key|secret)|change (?:a )?(?:password|credential)|cancel (?:a )?(?:booking|subscription|account))\b/i;

const NON_MUTATING_OUTCOME =
  /\b(research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b/i;

/**
 * Server-side last line of defence for every job producer. Callers may request
 * more gating, but a false/omitted flag can never waive policy.
 */
export function workApprovalPolicy(input: WorkApprovalInput): { required: boolean; reason?: string } {
  if (input.approvalRequired === true) return { required: true, reason: "caller marked the work consequential" };
  if (input.risk === "consequential") return { required: true, reason: "workstream risk is consequential" };

  // Read-only is an execution capability boundary, not merely prose. The
  // runner does not commit or deliver repository changes for these jobs and
  // its subprocess receives no application/provider credentials.
  if (input.readonly === true) return { required: false };

  if (CONSEQUENTIAL_ACTION.test(input.task)) {
    return { required: true, reason: "task requests an external, financial, production, or destructive action" };
  }

  // Repository work is isolated to a checkpoint branch/draft PR. Merge and
  // deployment remain consequential and were caught above.
  if (input.repo?.trim()) return { required: false };
  if (NON_MUTATING_OUTCOME.test(input.task)) return { required: false };

  // An unclassified non-repository job has no enforceable workspace boundary;
  // fail closed until Daniel approves it or the caller marks it read-only.
  return { required: true, reason: "unclassified non-repository action defaults to approval" };
}
