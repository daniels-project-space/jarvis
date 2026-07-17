const CHECKPOINT_LIMIT = 6000;

function clean(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function head(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 18)}\n…[trimmed]`;
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : `…[earlier trimmed]\n${value.slice(-(limit - 20))}`;
}

export function segmentTimeoutMs(modelTier: string): number {
  // Deep engineering and audit passes routinely need more than fifteen
  // minutes to inspect, test and form a verdict. They still checkpoint well
  // inside Trigger's one-hour task ceiling; lighter work stays responsive.
  return modelTier === "opus" ? 25 * 60_000 : 15 * 60_000;
}

export function buildContinuationCheckpoint(input: {
  attempt: number;
  timedOut: boolean;
  stopped?: "paused" | "cancelled" | null;
  priorCheckpoint?: string | null;
  narrative?: string | null;
  trace?: string | null;
  deliveryNote?: string | null;
}): string {
  const prior = clean(input.priorCheckpoint);
  const narrative = clean(input.narrative);
  const trace = clean(input.trace);
  const delivery = clean(input.deliveryNote);
  const boundary = input.timedOut
    ? "reached its bounded segment limit"
    : input.stopped
      ? `was ${input.stopped}`
      : "ended before supervisor verification";

  const sections = [
    `Attempt ${input.attempt} ${boundary}. Continue from the recorded evidence; do not restart broad discovery or rerun completed checks unless verification requires it.`,
  ];
  if (prior) sections.push(`PRIOR CHECKPOINT (retained):\n${tail(prior, 1100)}`);
  if (narrative) sections.push(`LATEST SPECIALIST NARRATIVE:\n${head(narrative, 1500)}`);
  if (trace) sections.push(`RECENT EXECUTION TRACE (completed commands and reasoning):\n${tail(trace, 2200)}`);
  if (delivery) sections.push(`DELIVERY STATE:\n${head(delivery, 250)}`);
  sections.push("NEXT SEGMENT: resolve only the unfinished definition-of-done items, then produce the requested final answer with evidence.");

  return sections.join("\n\n").slice(0, CHECKPOINT_LIMIT);
}
