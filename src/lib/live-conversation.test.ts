import { describe, expect, it } from "vitest";
import {
  advanceLiveConversation,
  inactiveLiveConversation,
  LIVE_CONVERSATION_IDLE_MS,
  type LiveConversationState,
} from "./live-conversation";

function start(now = 0): LiveConversationState {
  return advanceLiveConversation(inactiveLiveConversation(), { type: "start", now });
}

describe("live conversation lifecycle", () => {
  it("stays active through multiple consecutive assistant turns", () => {
    let state = start();
    state = advanceLiveConversation(state, { type: "speech-accepted", now: 1_000 });
    state = advanceLiveConversation(state, { type: "assistant-finished", now: 4_000 });
    state = advanceLiveConversation(state, { type: "speech-accepted", now: 5_000 });
    state = advanceLiveConversation(state, { type: "assistant-finished", now: 9_000 });

    expect(state).toMatchObject({ active: true, phase: "listening", completedTurns: 2 });
  });

  it("does not end the session for ordinary capture or transcript misses", () => {
    let state = start(10_000);
    state = advanceLiveConversation(state, { type: "capture-retryable-error", now: 12_000 });
    state = advanceLiveConversation(state, { type: "transcript-rejected", now: 14_000 });
    state = advanceLiveConversation(state, { type: "no-speech", now: 10_000 + LIVE_CONVERSATION_IDLE_MS - 1 });

    expect(state).toMatchObject({ active: true, phase: "listening" });
  });

  it("ends only for an explicit lifecycle event or the intentional idle timeout", () => {
    const active = start(2_000);
    expect(
      advanceLiveConversation(active, { type: "no-speech", now: 2_000 + LIVE_CONVERSATION_IDLE_MS }),
    ).toMatchObject({ active: false, phase: "off" });

    for (const type of ["explicit-stop", "permission-lost", "lease-lost", "page-hidden"] as const) {
      expect(advanceLiveConversation(active, { type, now: 3_000 })).toMatchObject({ active: false, phase: "off" });
    }
  });

  it("cannot be restarted by a late assistant completion after it was stopped", () => {
    let state = start();
    state = advanceLiveConversation(state, { type: "speech-accepted", now: 1_000 });
    state = advanceLiveConversation(state, { type: "explicit-stop", now: 2_000 });
    state = advanceLiveConversation(state, { type: "assistant-finished", now: 3_000 });

    expect(state).toMatchObject({ active: false, phase: "off", completedTurns: 0 });
  });

  it("ignores duplicate assistant completion without ending or double-counting the session", () => {
    let state = start();
    state = advanceLiveConversation(state, { type: "speech-accepted", now: 1_000 });
    state = advanceLiveConversation(state, { type: "assistant-finished", now: 2_000 });
    state = advanceLiveConversation(state, { type: "assistant-finished", now: 3_000 });

    expect(state).toMatchObject({ active: true, phase: "listening", completedTurns: 1 });
  });
});
