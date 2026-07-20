export type WarmHandoffControllerOptions<TPayload> = {
  runnerId: string;
  payload: () => TPayload;
  launch: (payload: TPayload, attempt: number) => Promise<boolean>;
  onTakeover: () => void;
  maxAttempts?: number;
  retryDelayMs?: number;
  failureRetryDelayMs?: number;
  launchTimeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type RunnerLeaseAcquisitionOptions = {
  acquire: () => Promise<boolean>;
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

export function isLegacyRunnerClaimValidationError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return /(?:extra|unexpected|unknown) field[\s\S]{0,160}\brunnerId\b|\brunnerId\b[\s\S]{0,160}(?:validator|extra|unexpected|unknown field)/i
    .test(detail);
}

/**
 * A ready successor may take the lease even when the HTTP response is lost.
 * Repeating the mutation with the same runner id is idempotent: it either
 * confirms that ownership or returns false if a different runner won.
 */
export async function acquireRunnerLease({
  acquire,
  maxAttempts = 3,
  retryDelayMs = 250,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}: RunnerLeaseAcquisitionOptions): Promise<boolean> {
  const attempts = Math.max(1, maxAttempts);
  const delayMs = Math.max(1, retryDelayMs);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await acquire();
    } catch (error) {
      if (attempt === attempts) throw error;
      await wait(delayMs);
    }
  }
  return false;
}

/**
 * Starts replacement workers without asking the current owner to stop draining.
 * A replacement becomes authoritative only when the caller observes the atomic
 * lease change; accepted launches that never become ready are retried finitely.
 */
export class WarmHandoffController<TPayload> {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly failureRetryDelayMs: number;
  private readonly launchTimeoutMs: number;
  private readonly schedule: NonNullable<WarmHandoffControllerOptions<TPayload>["schedule"]>;
  private readonly cancel: NonNullable<WarmHandoffControllerOptions<TPayload>["cancel"]>;
  private attempts = 0;
  private started = false;
  private stopped = false;
  private takenOver = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly options: WarmHandoffControllerOptions<TPayload>) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.retryDelayMs = Math.max(1, options.retryDelayMs ?? 30_000);
    this.failureRetryDelayMs = Math.max(1, options.failureRetryDelayMs ?? 2_000);
    this.launchTimeoutMs = Math.max(1, options.launchTimeoutMs ?? 15_000);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  start(): Promise<boolean> {
    if (this.started) return this.inFlight ?? Promise.resolve(false);
    this.started = true;
    return this.launchAttempt();
  }

  /** Force the next bounded attempt during abnormal/final cleanup. */
  ensureLaunched(): Promise<boolean> {
    if (this.stopped || this.takenOver || this.attempts >= this.maxAttempts) {
      return Promise.resolve(false);
    }
    if (!this.started) return this.start();
    if (this.inFlight) return this.inFlight;
    this.clearRetry();
    return this.launchAttempt();
  }

  observeRunner(runnerId: unknown): boolean {
    if (typeof runnerId !== "string" || !runnerId || runnerId === this.options.runnerId) return false;
    return this.markTakenOver();
  }

  markTakenOver(): boolean {
    if (this.takenOver) return false;
    this.takenOver = true;
    this.clearRetry();
    this.options.onTakeover();
    return true;
  }

  stop() {
    this.stopped = true;
    this.clearRetry();
  }

  get state() {
    return {
      attempts: this.attempts,
      started: this.started,
      takenOver: this.takenOver,
    };
  }

  private launchAttempt(): Promise<boolean> {
    if (this.stopped || this.takenOver || this.attempts >= this.maxAttempts) {
      return Promise.resolve(false);
    }
    const attempt = ++this.attempts;
    const launch = (async () => {
      let accepted = false;
      try {
        accepted = await this.launchWithinDeadline(this.options.payload(), attempt);
        return accepted;
      } finally {
        this.inFlight = null;
        if (!this.stopped && !this.takenOver && this.attempts < this.maxAttempts) {
          this.retryTimer = this.schedule(() => {
            this.retryTimer = null;
            void this.launchAttempt();
          }, accepted ? this.retryDelayMs : this.failureRetryDelayMs);
        }
      }
    })();
    this.inFlight = launch;
    return launch;
  }

  private launchWithinDeadline(payload: TPayload, attempt: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(accepted);
      };
      const timeout = setTimeout(() => finish(false), this.launchTimeoutMs);
      Promise.resolve()
        .then(() => this.options.launch(payload, attempt))
        .then((accepted) => finish(accepted), () => finish(false));
    });
  }

  private clearRetry() {
    if (!this.retryTimer) return;
    this.cancel(this.retryTimer);
    this.retryTimer = null;
  }
}
