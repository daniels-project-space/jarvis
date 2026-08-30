export const SELF_HOSTED_FOREGROUND_OPT_IN = "live";
export const SELF_HOSTED_FOREGROUND_RUNNER_PREFIX = "selfhost:";
export const FOREGROUND_RUNNER_FRESH_MS = 25_000;

export type ForegroundRunnerLease = {
  runnerId?: unknown;
  updatedAt?: unknown;
} | null;

export type ForegroundDispatchMode =
  | "trigger"
  | "selfhost"
  | "selfhost_unavailable"
  | "billing_paused";

export type ForegroundDispatchEnvironment = Readonly<Record<string, string | undefined>>;

export function freshSelfHostedForegroundLease(
  lease: ForegroundRunnerLease,
  now = Date.now(),
): boolean {
  if (!lease || typeof lease.runnerId !== "string") return false;
  if (!lease.runnerId.startsWith(SELF_HOSTED_FOREGROUND_RUNNER_PREFIX)) return false;
  const ageMs = now - Number(lease.updatedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FOREGROUND_RUNNER_FRESH_MS;
}

export function foregroundDispatchMode(
  env: ForegroundDispatchEnvironment,
  lease: ForegroundRunnerLease,
  now = Date.now(),
): ForegroundDispatchMode {
  if (env.JARVIS_SELF_HOSTED_FOREGROUND === SELF_HOSTED_FOREGROUND_OPT_IN) {
    return freshSelfHostedForegroundLease(lease, now) ? "selfhost" : "selfhost_unavailable";
  }
  return env.JARVIS_FOREGROUND_HOLD_REASON === "trigger_billing_limit"
    ? "billing_paused"
    : "trigger";
}

export function foregroundDispatchFailure(mode: ForegroundDispatchMode) {
  if (mode === "billing_paused") {
    return {
      code: "FOREGROUND_WORKERS_BILLING_PAUSED",
      message: "Reply workers are paused at the Trigger billing limit.",
    } as const;
  }
  if (mode === "selfhost_unavailable") {
    return {
      code: "SELF_HOSTED_FOREGROUND_OFFLINE",
      message: "The private Jarvis runner is offline.",
    } as const;
  }
  return null;
}
