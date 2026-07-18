import { describe, expect, it } from "vitest";
import { appendAgentMessageDelta, type AgentStreamState } from "./codex-stream";

describe("appendAgentMessageDelta", () => {
  it("preserves adjacent deltas within the same message item", () => {
    let state: AgentStreamState = { text: "" };
    ({ state } = appendAgentMessageDelta(state, "It is roughly", "item-1"));
    const next = appendAgentMessageDelta(state, " £2.4 million.", "item-1");
    expect(next.state.text).toBe("It is roughly £2.4 million.");
    expect(next.emitted).toBe(" £2.4 million.");
  });

  it("separates distinct assistant messages around a tool call", () => {
    const first = appendAgentMessageDelta({ text: "", itemId: undefined }, "I’m pulling that now.", "item-1");
    const second = appendAgentMessageDelta(first.state, "It’s roughly £2.4 million.", "item-2");
    expect(second.state.text).toBe("I’m pulling that now.\n\nIt’s roughly £2.4 million.");
    expect(second.emitted).toBe("\n\nIt’s roughly £2.4 million.");
  });

  it("does not double-separate when the protocol already includes whitespace", () => {
    const first = appendAgentMessageDelta({ text: "", itemId: undefined }, "One.\n", "item-1");
    expect(appendAgentMessageDelta(first.state, "Two.", "item-2").emitted).toBe("Two.");
  });
});
