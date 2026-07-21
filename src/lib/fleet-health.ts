export type FleetHealth = "queued" | "active" | "provider-waiting" | "checkpointed" | "retry-due" | "stalled" | "terminal";

/** Tier 0 is deliberately mechanical: elapsed runtime is never a fault. */
export function classifyFleetHealth(job: {
  status?: string; stage?: string; heartbeatAt?: number; nextRunAt?: number; checkpoint?: unknown; providerRunState?: string;
}, now = Date.now(), heartbeatTtlMs = 5 * 60_000): FleetHealth {
  const status = String(job.status ?? "pending");
  if (["done", "error", "cancelled"].includes(status)) return "terminal";
  if (status === "stalled") return "stalled";
  if (status === "running" || status === "dispatching" || status === "steering") {
    if (Number(job.heartbeatAt ?? 0) < now - heartbeatTtlMs) return "stalled";
    if (/waiting|delayed/i.test(String(job.providerRunState ?? "")) || /delivery|integration|provider/i.test(String(job.stage ?? ""))) return "provider-waiting";
    return "active";
  }
  if (status === "pending" && Number(job.nextRunAt ?? 0) > now) return "retry-due";
  if (status === "paused" || status === "needs_input" || job.checkpoint) return "checkpointed";
  return "queued";
}
