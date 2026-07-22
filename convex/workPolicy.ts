import { classifyWorkSafety, isOwnedRepository } from "../src/lib/work-safety";
import { WORKFLOW_CONTRACT } from "../src/lib/workflow-contract";

export type WorkApprovalInput = {
  task: string;
  repo?: string;
  readonly?: boolean;
  risk?: string;
  approvalRequired?: boolean;
};

export type WorkDeliveryMode = "read_only" | "branch_only" | "auto_merge" | "manual";

export type WorkApprovalDecision = {
  required: boolean;
  reason?: string;
  deliveryMode: WorkDeliveryMode;
};

export type GoalWorkApprovalInput = WorkApprovalInput & {
  goalStage: "planning" | "building" | "validating" | "refining";
};

const NON_MUTATING_OUTCOME =
  /\b(research|investigate|inspect|audit|review|analyse|analyze|compare|summari[sz]e|report|recommend|brainstorm|plan|draft|design|draw|illustrat|write|explain|calculate|model|prototype|test|verify|locate|list)\b/i;

/**
 * Server-side last line of defence for every job producer. Capability and
 * consequence policy override stale planner hints in both directions.
 */
export function workApprovalPolicy(input: WorkApprovalInput): WorkApprovalDecision {
  // Convex policy shares the manifest-derived trust boundary used by Mastra
  // and the Trigger runner. Drift must fail closed.
  if (WORKFLOW_CONTRACT.credentialBoundary !== "controller-held-only") {
    return { required: true, reason: "workflow contract credential boundary is invalid", deliveryMode: "manual" };
  }
  const safety = classifyWorkSafety(input.task, { repo: input.repo });
  if (safety.approvalRequired) {
    return { required: true, reason: safety.reason, deliveryMode: "manual" };
  }

  // Once the hard consequence classifier has passed, capability boundaries
  // decide autonomy. A planner's stale `approvalRequired`/risk hint must not
  // recreate Daniel-facing approval cards for safe repository work.
  if (input.readonly === true) return { required: false, deliveryMode: "read_only" };
  if (input.repo?.trim()) {
    if (isOwnedRepository(input.repo)) return { required: false, deliveryMode: "branch_only" };
    return {
      required: true,
      reason: "repository is outside Daniel's autonomous portfolio",
      deliveryMode: "manual",
    };
  }

  if (input.approvalRequired === true) {
    return { required: true, reason: "caller marked the work consequential", deliveryMode: "manual" };
  }
  if (input.risk === "consequential") {
    return { required: true, reason: "workstream risk is consequential", deliveryMode: "manual" };
  }

  // The hard classifier above runs before this capability boundary, so a
  // malformed read-only route can never waive an external consequence.
  if (NON_MUTATING_OUTCOME.test(input.task)) return { required: false, deliveryMode: "read_only" };

  // An unclassified non-repository job has no enforceable workspace boundary;
  // fail closed until Daniel approves it or the caller marks it read-only.
  return {
    required: true,
    reason: "unclassified non-repository action defaults to approval",
    deliveryMode: "manual",
  };
}

/**
 * Goal Mode's planner and validator are trusted, internally-created review
 * sessions. Their prompts quote the requested outcome and build evidence, so
 * the text can legitimately contain words such as "send", "pay" or "delete"
 * even though the session is explicitly read-only and has no delivery path.
 *
 * Keep that narrow provenance decision here instead of weakening the general
 * consequence classifier: building/refining sessions and every caller-created
 * job still pass through the normal fail-closed policy.
 */
export function goalWorkApprovalPolicy(input: GoalWorkApprovalInput): WorkApprovalDecision {
  if (input.readonly === true && (input.goalStage === "planning" || input.goalStage === "validating")) {
    return { required: false, deliveryMode: "read_only" };
  }
  return workApprovalPolicy(input);
}
