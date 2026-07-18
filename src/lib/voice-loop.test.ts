import { describe, expect, it } from "vitest";
import { nextVoiceLoopAction } from "./voice-loop";

describe("nextVoiceLoopAction", () => {
  it.each(["silence", "empty", "echo"] as const)(
    "keeps a persistent live session listening after %s",
    (outcome) => {
      expect(nextVoiceLoopAction({ outcome, persistentLive: true, loopRequested: true })).toBe("listen");
    },
  );

  it("waits for the assistant after captured speech", () => {
    expect(
      nextVoiceLoopAction({ outcome: "speech", persistentLive: true, loopRequested: true }),
    ).toBe("await-reply");
  });

  it("ends a one-shot wake capture after silence", () => {
    expect(
      nextVoiceLoopAction({ outcome: "silence", persistentLive: false, loopRequested: true }),
    ).toBe("stop");
  });

  it("stops on device failure or an explicit live-off request", () => {
    expect(
      nextVoiceLoopAction({ outcome: "failure", persistentLive: true, loopRequested: true }),
    ).toBe("stop");
    expect(
      nextVoiceLoopAction({ outcome: "silence", persistentLive: true, loopRequested: false }),
    ).toBe("stop");
  });
});
