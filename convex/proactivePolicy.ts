export type ProactiveGoal = {
  _id: unknown;
  project: string;
  title: string;
  status: string;
  priority: number;
  blockedBy?: string;
  nextAction?: string;
  updatedAt: number;
};

export type ProactiveJob = {
  _id: unknown;
  status: string;
  task: string;
  label?: string;
  repo?: string;
  agentId?: string;
  visibility?: string;
  incidentId?: string;
  missionId?: string;
  nextRunAt?: number;
  heartbeatAt?: number;
  startedAt?: number;
  createdAt: number;
};

export type ProactiveSignal = {
  fingerprint: string;
  project?: string;
  title: string;
  detail: string;
  evidence: string[];
  severity: "warning" | "critical" | "decision";
  impact: number;
  urgency: number;
  confidence: number;
  actionClass: "inform" | "ask" | "propose";
  jobId?: string;
};

const TWENTY_MINUTES = 20 * 60_000;
const THREE_DAYS = 3 * 86_400_000;

export function countGeneralFleetDemand(input: {
  jobs: ProactiveJob[];
  goalMissionIds: Set<string>;
  now: number;
}): number {
  return input.jobs.filter((job) =>
    job.status === "pending"
    && (job.nextRunAt ?? job.createdAt) <= input.now
    && (!job.missionId || !input.goalMissionIds.has(job.missionId)),
  ).length;
}

/**
 * Rank only facts the state machine can prove. Codex CLI agents diagnose and
 * repair; this layer never invents a problem from a healthy-state summary.
 */
export function deriveProactiveSignals(input: {
  goals: ProactiveGoal[];
  jobs: ProactiveJob[];
  now: number;
}): ProactiveSignal[] {
  const { goals, jobs, now } = input;
  const signals: ProactiveSignal[] = [];
  const liveRunner = jobs.some(
    (job) =>
      ["dispatching", "running"].includes(job.status) &&
      now - (job.heartbeatAt ?? job.startedAt ?? job.createdAt) < 5 * 60_000,
  );
  const overduePending = jobs
    .filter(
      (job) =>
        job.status === "pending" &&
        (job.nextRunAt ?? job.createdAt) <= now &&
        now - job.createdAt >= TWENTY_MINUTES,
    )
    .sort((left, right) => left.createdAt - right.createdAt);

  if (overduePending.length && !liveRunner) {
    const oldest = overduePending[0];
    signals.push({
      fingerprint: "proactive:agent-fleet:not-claiming",
      project: "jarvis",
      title: "Agent fleet is not claiming work",
      detail: `${overduePending.length} eligible job${overduePending.length === 1 ? " has" : "s have"} waited over 20 minutes with no live worker heartbeat.`,
      evidence: [
        `oldest job ${String(oldest._id)}`,
        `queued at ${new Date(oldest.createdAt).toISOString()}`,
      ],
      severity: "critical",
      impact: 90,
      urgency: 85,
      confidence: 1,
      actionClass: "ask",
      jobId: String(oldest._id),
    });
  }

  for (const goal of goals) {
    if (goal.status !== "blocked" || goal.priority < 70) continue;
    const requiresDaniel = Boolean(goal.blockedBy && /\b(daniel|decision|choose|approval|approve|confirm)\b/i.test(goal.blockedBy));
    signals.push({
      fingerprint: `proactive:goal-blocked:${String(goal._id)}`,
      project: goal.project,
      title: `Blocked outcome · ${goal.title}`.slice(0, 140),
      detail: (goal.blockedBy || goal.nextAction || "A high-priority durable outcome is blocked without a recorded next action.").slice(0, 2_000),
      evidence: [`priority ${goal.priority}`, `blocked goal ${String(goal._id)}`],
      severity: requiresDaniel ? "decision" : "warning",
      impact: goal.priority,
      urgency: requiresDaniel ? 70 : 50,
      confidence: 1,
      actionClass: requiresDaniel ? "ask" : "propose",
    });
  }

  for (const job of jobs) {
    if (
      job.status !== "error" ||
      job.visibility !== "conversation" ||
      job.incidentId ||
      now - job.createdAt > THREE_DAYS
    ) continue;
    signals.push({
      fingerprint: `proactive:job-failed:${String(job._id)}`,
      project: job.repo,
      title: `Unresolved team failure · ${(job.label || job.task).slice(0, 100)}`,
      detail: `${job.agentId ?? "A specialist"} stopped without a verified result. Retry or rescope it from the command deck; it will not be silently called complete.`,
      evidence: [`job ${String(job._id)}`, `status error`],
      severity: "warning",
      impact: 65,
      urgency: 55,
      confidence: 1,
      actionClass: "propose",
      jobId: String(job._id),
    });
  }

  return signals
    .sort((left, right) => right.impact * right.urgency * right.confidence - left.impact * left.urgency * left.confidence)
    .slice(0, 8);
}
