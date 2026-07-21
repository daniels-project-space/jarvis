import { leaseDecision, type LeaseSnapshot } from "../lib/durable-attempt-protocol";

export type LeaseStatus = "running" | "paused" | "cancelled" | "steered" | "superseded" | "unknown";

/**
 * One bounded monitor used by the runner. Subscription failures retain a
 * recent known-good lease, then cause exactly one fail-safe query per retry
 * window. Unknown is terminal for the local segment: callers checkpoint and
 * requeue instead of silently returning or continuing forever.
 */
export class ExecutionLeaseMonitor {
  private lease: LeaseSnapshot | null = null;
  private observedAt = 0;
  private lastFallbackAt = -Infinity;

  constructor(
    private readonly expectedAttempt: number,
    private readonly expectedSteerRevision: number,
    private readonly query: () => Promise<LeaseSnapshot | null>,
    private readonly now: () => number = Date.now,
    private readonly maxKnownAgeMs = 30_000,
    private readonly fallbackIntervalMs = 15_000,
  ) {}

  observe(value: LeaseSnapshot | null | undefined) {
    if (value) { this.lease = value; this.observedAt = this.now(); }
  }

  async status(): Promise<LeaseStatus> {
    const time = this.now();
    let decision = leaseDecision({ now: time, expectedAttempt: this.expectedAttempt, expectedSteerRevision: this.expectedSteerRevision, lease: this.lease, leaseObservedAt: this.observedAt, maxKnownAgeMs: this.maxKnownAgeMs });
    if (decision === "running" || decision === "paused" || decision === "cancelled" || decision === "steered" || decision === "superseded") return decision;
    if (time - this.lastFallbackAt < this.fallbackIntervalMs) return "unknown";
    this.lastFallbackAt = time;
    try {
      const fresh = await this.query();
      if (!fresh) return "unknown";
      this.observe(fresh);
      decision = leaseDecision({ now: this.now(), expectedAttempt: this.expectedAttempt, expectedSteerRevision: this.expectedSteerRevision, lease: this.lease, leaseObservedAt: this.observedAt, maxKnownAgeMs: this.maxKnownAgeMs });
      return decision === "query" ? "unknown" : decision;
    } catch { return "unknown"; }
  }
}
