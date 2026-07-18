/**
 * Serialises model deltas into idempotent full-text snapshots.
 *
 * The old publisher launched a recursive, unawaited flush when new text
 * arrived during a network write. That write could outlive finalization and
 * append the opening of the answer a second time. This publisher has one
 * promise chain; close() is a hard barrier before Convex finalization.
 */
export class StreamPublisher {
  private text = "";
  private queuedText = "";
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private readonly publish: (text: string, revision: number) => Promise<unknown>,
    private readonly intervalMs = 120,
  ) {}

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  push(delta: string) {
    if (this.closed || !delta) return;
    this.text += delta;
  }

  flush(): Promise<void> {
    const snapshot = this.text;
    if (!snapshot || snapshot === this.queuedText) return this.chain;
    this.queuedText = snapshot;
    const revision = ++this.revision;
    this.chain = this.chain.then(async () => {
      // A failed interim paint is harmless: finalize writes the authoritative
      // complete answer. Most importantly, no rejected write can fork a second
      // chain or escape the close barrier.
      await this.publish(snapshot, revision).catch(() => undefined);
    });
    return this.chain;
  }

  async close(): Promise<void> {
    if (this.closed) return this.chain;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    await this.chain;
  }

  get value() {
    return this.text;
  }
}
