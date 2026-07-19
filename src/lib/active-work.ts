export type ActiveWork = {
  _id?: unknown;
  status?: string;
  visibility?: "conversation" | "system" | string;
  agentId?: string;
  label?: string;
  task?: string;
  stage?: string;
  incidentId?: string;
};

const ACTIVE_STATUSES = new Set(["running", "awaiting_approval", "needs_input"]);
const DECISION_STATUSES = new Set(["awaiting_approval", "needs_input"]);
const LEGACY_SYSTEM_WORK = /\b(?:health[ -]?check|heartbeat|uptime poll|stack poll|polling sweep|sentry sweep|provider health|background check|routine monitor)\b/i;

/**
 * The live-work pill is an attention surface, not an operations log.
 * Decisions are always relevant; executing system maintenance stays available
 * in project/agent views without interrupting the conversation surface.
 */
export function isRelevantActiveWork(job: ActiveWork): boolean {
  const status = String(job.status ?? "");
  if (!ACTIVE_STATUSES.has(status)) return false;
  // Incident repair is operations telemetry, even when its worker is waiting
  // on a provider publication or approval. Alerts retains that attention;
  // the conversational work pill is reserved for Daniel's deliberate work.
  if (job.visibility === "system" || job.incidentId || (job.agentId === "sentry" && job.visibility !== "conversation")) return false;
  if (DECISION_STATUSES.has(status)) return true;
  if (job.visibility === "conversation") return true;

  // Compatibility for jobs created before visibility was recorded explicitly.
  return !LEGACY_SYSTEM_WORK.test([job.label, job.task, job.stage].filter(Boolean).join(" "));
}

export function relevantActiveWork<T extends ActiveWork>(jobs: readonly T[], limit = 4): T[] {
  return jobs.filter(isRelevantActiveWork).slice(0, Math.max(0, limit));
}

export function needsDaniel(job: ActiveWork): boolean {
  return DECISION_STATUSES.has(String(job.status ?? ""));
}
