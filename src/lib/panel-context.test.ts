import { describe, expect, it } from "vitest";
import { isPanelFollowUp, type ConversationPanel } from "./panel-context";

const bitcoinChart: ConversationPanel = {
  type: "widget",
  title: "BTC · 1h",
  value: JSON.stringify({ kind: "candles", asset: "BTC", interval: "1h" }),
};

describe("conversation panel context", () => {
  it("dismisses a Bitcoin chart when the conversation moves to an unrelated topic", () => {
    expect(isPanelFollowUp("What's the weather in Lisbon tomorrow?", bitcoinChart)).toBe(false);
    expect(isPanelFollowUp("Add milk to my todo list", bitcoinChart)).toBe(false);
    expect(isPanelFollowUp("Tell me a joke", bitcoinChart)).toBe(false);
    expect(isPanelFollowUp("What time is it?", bitcoinChart)).toBe(false);
    expect(isPanelFollowUp("What about tomorrow's weather?", bitcoinChart)).toBe(false);
  });

  it("retains the chart for meaningful subject and deictic follow-ups", () => {
    expect(isPanelFollowUp("Why did Bitcoin drop?", bitcoinChart)).toBe(true);
    expect(isPanelFollowUp("What does this move mean?", bitcoinChart)).toBe(true);
    expect(isPanelFollowUp("Show me the four hour timeframe", bitcoinChart)).toBe(true);
    expect(isPanelFollowUp("Tell me more", bitcoinChart)).toBe(true);
    expect(isPanelFollowUp("Why?", bitcoinChart)).toBe(true);
    expect(isPanelFollowUp("What about Ethereum?", bitcoinChart)).toBe(true);
  });

  it("uses structured ranking content for follow-ups without making generic questions sticky", () => {
    const ranking: ConversationPanel = {
      type: "widget",
      title: "Best directors",
      value: JSON.stringify({ kind: "ranking", items: [{ rank: 1, name: "Denis Villeneuve" }] }),
    };
    expect(isPanelFollowUp("Tell me about Denis Villeneuve", ranking)).toBe(true);
    expect(isPanelFollowUp("Who is number one?", ranking)).toBe(true);
    expect(isPanelFollowUp("How is my calendar looking?", ranking)).toBe(false);
  });

  it("treats an explicit close request as a context exit", () => {
    expect(isPanelFollowUp("Close that chart", bitcoinChart)).toBe(false);
  });
});
