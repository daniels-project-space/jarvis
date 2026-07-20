const RESUME_NOTE = "Daniel resumed the parent goal. Preserve completed evidence and retry only the unfinished boundary.";

export function shouldPauseGoalJob(status: unknown): boolean {
  // Pending jobs remain fenced by their paused parent mission and have not
  // consumed a worker lease. A dispatch reservation or active worker must be
  // invalidated immediately.
  return status === "dispatching" || status === "running";
}

export function isResumeOnlyUntouchedGoalJob(job: {
  status?: unknown;
  progress?: unknown;
  checkpoint?: unknown;
  startedAt?: unknown;
  workerRunId?: unknown;
  result?: unknown;
}): boolean {
  if (job.status !== "pending" || job.progress !== "Goal Mode recovery queued") return false;
  if (job.startedAt || job.workerRunId || String(job.result ?? "").trim()) return false;
  const lines = String(job.checkpoint ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === RESUME_NOTE);
}

