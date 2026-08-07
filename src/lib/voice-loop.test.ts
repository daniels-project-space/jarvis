import { describe, expect, it } from "vitest";
import { nextVoiceLoopAction, shouldMaintainLiveHeartbeat } from "./voice-loop";

describe("nextVoiceLoopAction", () => {
  it.each(["silence", "empty", "echo"] as const)(
    "keeps a persistent live session listening after %s",
    (outcome) => {
      expect(nextVoiceLoopAction({ outcome, persistentLive: true, loopRequested: true })).toBe("listen");
    },
  );

  it("keeps listening after captured speech in a persistent live session", () => {
    expect(
      nextVoiceLoopAction({ outcome: "speech", persistentLive: true, loopRequested: true }),
    ).toBe("listen");
  });

  it("waits for the assistant in a one-shot wake session", () => {
    expect(
      nextVoiceLoopAction({ outcome: "speech", persistentLive: false, loopRequested: true }),
    ).toBe("await-reply");
  });

  it("ends a one-shot wake capture after silence", () => {
    expect(
      nextVoiceLoopAction({ outcome: "silence", persistentLive: false, loopRequested: true }),
    ).toBe("stop");
  });

  it("recovers a persistent device failure but obeys an explicit live-off request", () => {
    expect(
      nextVoiceLoopAction({ outcome: "failure", persistentLive: true, loopRequested: true }),
    ).toBe("listen");
    expect(
      nextVoiceLoopAction({ outcome: "silence", persistentLive: true, loopRequested: false }),
    ).toBe("stop");
  });
});

describe("shouldMaintainLiveHeartbeat", () => {
  it("writes ownership only for a visible authenticated live session", () => {
    expect(shouldMaintainLiveHeartbeat({ guest: false, visible: true, live: true })).toBe(true);
    expect(shouldMaintainLiveHeartbeat({ guest: true, visible: true, live: true })).toBe(false);
    expect(shouldMaintainLiveHeartbeat({ guest: false, visible: false, live: true })).toBe(false);
    expect(shouldMaintainLiveHeartbeat({ guest: false, visible: true, live: false })).toBe(false);
  });
});
