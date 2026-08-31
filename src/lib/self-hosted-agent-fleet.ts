import type { AgentFleetReservation } from "./agent-fleet-dispatch";

const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const SUPERVISOR_INTERVAL_MS = 15_000;
const PROVIDER_REVALIDATE_INTERVAL_MS = 4 * 60 * 60_000;

export type SelfHostedAgentFleetCycleResult = {
  processed: number;
  jobId?: string;
};

export type SelfHostedAgentFleetDependencies = {
  activateProtocol(): Promise<void>;
  validateProvider(): Promise<void>;
  resumeProviderHolds(): Promise<void>;
  runMaintenance(): Promise<void>;
  runSupervisorSweep(signal: AbortSignal): Promise<void>;
  reserve(reason: string, limit: number): Promise<AgentFleetReservation[]>;
  runJob(reservation: AgentFleetReservation, signal: AbortSignal): Promise<void>;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
  now(): number;
};

export async function runSelfHostedAgentFleetController(
  pollMs: number,
  signal: AbortSignal,
  dependencies: SelfHostedAgentFleetDependencies,
): Promise<void> {
  await dependencies.validateProvider();
  await dependencies.activateProtocol();
  await dependencies.resumeProviderHolds();

  let providerDueAt = dependencies.now() + PROVIDER_REVALIDATE_INTERVAL_MS;
  let maintenanceDueAt = 0;
  let supervisorDueAt = 0;
  let maintenanceInFlight: Promise<void> | null = null;
  let supervisorInFlight: Promise<void> | null = null;
  while (!signal.aborted) {
    const now = dependencies.now();
    if (now >= providerDueAt) {
      await dependencies.validateProvider();
      await dependencies.resumeProviderHolds();
      providerDueAt = now + PROVIDER_REVALIDATE_INTERVAL_MS;
    }
    if (now >= maintenanceDueAt) {
      maintenanceDueAt = now + MAINTENANCE_INTERVAL_MS;
      // Recovery/reminder work is useful but must never become a head-of-line
      // block for a newly queued specialist. Keep one bounded logical flight;
      // a slow provider call may finish later, while reservations keep moving.
      if (!maintenanceInFlight) {
        maintenanceInFlight = Promise.resolve()
          .then(() => dependencies.runMaintenance())
          .catch(() => undefined)
          .finally(() => { maintenanceInFlight = null; });
      }
    }
    if (now >= supervisorDueAt) {
      supervisorDueAt = now + SUPERVISOR_INTERVAL_MS;
      // The supervisor sweep has its own durable leases. Run at most one in
      // the background so an unavailable supervisor dependency cannot freeze
      // the specialist reservation loop, as happened in production.
      if (!supervisorInFlight) {
        supervisorInFlight = Promise.resolve()
          .then(() => dependencies.runSupervisorSweep(signal))
          .catch(() => undefined)
          .finally(() => { supervisorInFlight = null; });
      }
    }

    const [reservation] = await dependencies.reserve("selfhost-daemon", 1);
    if (reservation) {
      await dependencies.runJob(reservation, signal);
      // A completed specialist may make both a successor job and a supervisor
      // decision immediately runnable. Recheck both durable authorities now,
      // rather than sleeping or relying on a paid wake transport.
      supervisorDueAt = 0;
      continue;
    }
    if (signal.aborted) break;
    await dependencies.wait(pollMs, signal);
  }
}
