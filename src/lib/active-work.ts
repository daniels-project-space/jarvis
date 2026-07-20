export type CompactWorkItem = {
  id: string;
  label: string;
  status: "dispatching" | "running";
  stage: string;
  percent: number;
};

export type CompactWorkSnapshot = { active: CompactWorkItem | null };

export type CompactWorkCache = {
  threadId: string;
  active: CompactWorkItem | null;
} | null;

/**
 * A resolved server result is authoritative, including an explicit empty one.
 * While the same subscription is unresolved during a refresh, retain its last
 * result so an active bar does not flash out and back in.
 */
export function visibleCompactWork(
  cache: CompactWorkCache,
  threadId: string,
  snapshot: CompactWorkSnapshot | undefined,
): CompactWorkItem | null {
  if (snapshot !== undefined) return snapshot.active;
  return cache?.threadId === threadId ? cache.active : null;
}

export function cacheCompactWorkSnapshot(
  cache: CompactWorkCache,
  threadId: string,
  snapshot: CompactWorkSnapshot | undefined,
): CompactWorkCache {
  return snapshot === undefined ? cache : { threadId, active: snapshot.active };
}

export function needsDaniel(job: { status?: string }): boolean {
  return job.status === "awaiting_approval" || job.status === "needs_input";
}
