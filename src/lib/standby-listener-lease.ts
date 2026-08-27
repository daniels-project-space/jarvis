import { withClientDeadline } from "./client-deadline";

// Keep this five-second safety margin beneath convex/ui.ts's 25-second lease.
// A browser that loses its Convex connection must stop local recognition before
// another document is allowed to take over the shared server lease.
export const STANDBY_LISTENER_SERVER_LEASE_MS = 25_000;
export const STANDBY_LISTENER_LOCAL_LEASE_MS = 16_000;
export const STANDBY_LISTENER_RENEWAL_INTERVAL_MS = 8_000;
export const STANDBY_LISTENER_RENEWAL_DEADLINE_MS = 4_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduleTimer = (callback: () => void, delayMs: number) => TimerHandle;
type CancelTimer = (timer: TimerHandle) => void;
type StandbyRandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint32Array) => Uint32Array;
};

export type StandbyListenerLease = {
  id: string;
  sequence: number;
};

/**
 * Passive browser recognition and a persistent live microphone session must
 * never coexist in one document. Keeping this policy here makes every
 * re-arm path (including a late host/embed handoff) share the same fence.
 */
export function shouldArmStandbyListener({
  guest,
  client,
  eligible,
  hidden,
  live,
}: {
  guest: boolean;
  client: string | null;
  eligible: boolean;
  hidden: boolean;
  live: boolean;
}): boolean {
  return !guest && !!client && eligible && !hidden && !live;
}

// A standby identity belongs to one mounted Jarvis document, never to shared
// session storage. Duplicated tabs can inherit sessionStorage, which would let
// two recognizers renew an otherwise valid server lease under the same client.
export function createStandbyListenerClientId(
  source: StandbyRandomSource | undefined = globalThis.crypto as StandbyRandomSource | undefined,
): string | null {
  try {
    const uuid = source?.randomUUID?.();
    if (uuid) return `standby:${uuid}`;
  } catch {
    // A browser may expose crypto but reject randomUUID in an unusual context.
  }
  if (!source?.getRandomValues) return null;
  try {
    const values = new Uint32Array(4);
    source.getRandomValues(values);
    return `standby:${Array.from(values, (value) => value.toString(36)).join("-")}`;
  } catch {
    return null;
  }
}

export function nextStandbyListenerLease(
  clientId: string,
  previousSequence: number,
): StandbyListenerLease {
  const sequence = previousSequence + 1;
  if (!clientId || !Number.isSafeInteger(previousSequence) || previousSequence < 0 || !Number.isSafeInteger(sequence)) {
    throw new Error("Invalid standby listener lease sequence");
  }
  return { id: `${clientId}:${sequence}`, sequence };
}

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
