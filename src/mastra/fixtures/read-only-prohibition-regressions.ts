export const LONG_COORDINATED_READ_ONLY_PROHIBITION =
  "READ ONLY: do not edit, commit, push, PR, merge, deploy, change credentials, call provider write endpoints, create drafts/orders/carts/customers/inventory, publish, message, advertise, spend, or mutate any provider.";

export const DROPSHIP_READ_ONLY_AUDIT_PROMPTS = [
  `${LONG_COORDINATED_READ_ONLY_PROHIBITION}\nAudit the Dropship orchestration path and report the exact repository evidence.`,
  `${LONG_COORDINATED_READ_ONLY_PROHIBITION}\nInspect the current production configuration through read-only observations and identify any drift.`,
  `${LONG_COORDINATED_READ_ONLY_PROHIBITION}\nReview the supplier and commerce safety boundaries, then return a concise evidence-only assessment.`,
] as const;

const COORDINATED_PROHIBITION_WITHOUT_STOP =
  LONG_COORDINATED_READ_ONLY_PROHIBITION.slice(0, -1);

export const PROHIBITION_FOLLOWED_BY_CONSEQUENTIAL_ACTION = [
  `${LONG_COORDINATED_READ_ONLY_PROHIBITION} Delete the production records.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}; Change the credential now.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}, but send the customer a reply.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}; however, publish the audit publicly.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}, then purchase the selected product.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}, yet deploy the provider change to production.`,
  `${COORDINATED_PROHIBITION_WITHOUT_STOP}; instead, rotate a key.`,
] as const;
