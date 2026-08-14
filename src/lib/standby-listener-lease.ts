import { withClientDeadline } from "./client-deadline";

// Keep this five-second safety margin beneath convex/ui.ts's 25-second lease.
// A browser that loses its Convex connection must stop local recognition before
// another document is allowed to take over the shared server lease.
export const STANDBY_LISTENER_SERVER_LEASE_MS = 25_000;
export const STANDBY_LISTENER_LOCAL_LEASE_MS = 20_000;
export const STANDBY_LISTENER_RENEWAL_INTERVAL_MS = 8_000;
export const STANDBY_LISTENER_RENEWAL_DEADLINE_MS = 4_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduleTimer = (callback: () => void, delayMs: number) => TimerHandle;
type CancelTimer = (timer: TimerHandle) => void;

export function createStandbyListenerLeaseFence({
  onExpiry,
  leaseMs = STANDBY_LISTENER_LOCAL_LEASE_MS,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (timer) => clearTimeout(timer),
}: {
  onExpiry: () => void;
  leaseMs?: number;
  schedule?: ScheduleTimer;
  cancel?: CancelTimer;
}) {
  let timer: TimerHandle | null = null;
  let generation = 0;

  const clear = () => {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
  };

  const renew = () => {
    clear();
    const leaseGeneration = generation;
    timer = schedule(() => {
      if (leaseGeneration !== generation) return;
      timer = null;
      generation += 1;
      onExpiry();
    }, leaseMs);
  };

  return { clear, renew };
}

export async function renewStandbyListenerLease({
  renewRemote,
  stillOwnsLease,
  onRenewed,
  onLost,
}: {
  renewRemote: () => Promise<boolean>;
  stillOwnsLease: () => boolean;
  onRenewed: () => void;
  onLost: () => void;
}): Promise<boolean> {
  try {
    const held = await withClientDeadline(
      renewRemote(),
      STANDBY_LISTENER_RENEWAL_DEADLINE_MS,
      "standby listener renewal",
    );
    if (!stillOwnsLease()) return false;
    if (held !== true) {
      onLost();
      return false;
    }
    onRenewed();
    return true;
  } catch {
    if (stillOwnsLease()) onLost();
    return false;
  }
}
