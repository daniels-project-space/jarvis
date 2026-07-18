type ConcurrentClaimLoopOptions<Job> = {
  capacity: number;
  claimWindowMs: number;
  idleDrainMs: number;
  pollIntervalMs: number;
  claim: () => Promise<Job | null>;
  run: (job: Job) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A workflow owns only a short claim window. Additional GitHub wake runs can
// overlap it and atomically lease follow-up jobs, so a long Paul task never
// monopolises the team. Within this wake, empty capacity keeps polling instead
// of waiting for the longest process to finish.
export async function runConcurrentClaimLoop<Job>(options: ConcurrentClaimLoopOptions<Job>): Promise<number> {
  const capacity = Math.max(1, Math.floor(options.capacity));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let emptySince: number | null = null;
  let processed = 0;
  const inFlight = new Set<Promise<void>>();

  while (now() - startedAt < options.claimWindowMs) {
    if (inFlight.size >= capacity) {
      await Promise.race(inFlight);
      emptySince = null;
      continue;
    }

    const job = await options.claim();
    if (job) {
      emptySince = null;
      processed += 1;
      const execution = options.run(job);
      inFlight.add(execution);
      void execution.then(
        () => inFlight.delete(execution),
        () => inFlight.delete(execution),
      );
      continue;
    }

    emptySince ??= now();
    if (inFlight.size === 0 && now() - emptySince >= options.idleDrainMs) break;
    await Promise.race([...inFlight, sleep(options.pollIntervalMs)]);
  }

  await Promise.all(inFlight);
  return processed;
}
