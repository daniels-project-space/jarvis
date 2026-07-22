import { describe, expect, it } from "vitest";
import { StreamPublisher } from "./stream-publisher";

describe("StreamPublisher", () => {
  it("drains every queued snapshot before finalization can continue", async () => {
    const releases: Array<() => void> = [];
    const writes: Array<{ text: string; revision: number }> = [];
    const publisher = new StreamPublisher((text, revision) => new Promise<void>((resolve) => {
      writes.push({ text, revision });
      releases.push(resolve);
    }));

    publisher.push("Good");
    void publisher.flush();
    publisher.push(" morning");
    void publisher.flush();
    const closing = publisher.close();

    await Promise.resolve();
    expect(writes).toEqual([{ text: "Good", revision: 1 }]);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([
      { text: "Good", revision: 1 },
      { text: "Good morning", revision: 2 },
    ]);
    releases.shift()?.();
    await closing;
  });

  it("publishes full snapshots once and ignores deltas after close", async () => {
    const writes: Array<{ text: string; revision: number }> = [];
    const publisher = new StreamPublisher(async (text, revision) => {
      writes.push({ text, revision });
    });
    publisher.push("One");
    await publisher.flush();
    await publisher.flush();
    await publisher.close();
    publisher.push(" two");
    await publisher.flush();
    expect(writes).toEqual([{ text: "One", revision: 1 }]);
    expect(publisher.value).toBe("One");
  });

  it("records only the first durable Convex paint", async () => {
    let painted = 0;
    const publisher = new StreamPublisher(async () => true, 120, () => { painted += 1; });
    publisher.push("One");
    await publisher.flush();
    publisher.push(" two");
    await publisher.flush();
    expect(painted).toBe(1);
  });
});
