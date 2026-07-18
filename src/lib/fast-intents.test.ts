import { describe, expect, it } from "vitest";
import { parseFastChartIntent, parseFastNetWorthIntent } from "./fast-intents";

describe("parseFastChartIntent", () => {
  it("opens a direct Bitcoin chart without involving the model", () => {
    expect(parseFastChartIntent("show me the BTC chart")).toEqual({ asset: "btc", interval: "1d" });
  });

  it("keeps analysis and trading questions in the analyst lane", () => {
    expect(parseFastChartIntent("should I buy BTC after looking at the chart?")).toBeNull();
  });

  it("recognises a requested chart interval", () => {
    expect(parseFastChartIntent("Ethereum 4h candles")).toEqual({ asset: "eth", interval: "4h" });
  });
});

describe("parseFastNetWorthIntent", () => {
  it("opens a direct net-worth request without waiting for a model", () => {
    expect(parseFastNetWorthIntent("what is my net worth?"))
      .toEqual({ requiresAnalysis: false });
  });

  it("opens the visual first but preserves the reasoning lane for analysis", () => {
    expect(parseFastNetWorthIntent("analyse my net worth and tell me what to improve"))
      .toEqual({ requiresAnalysis: true });
  });

  it("does not hijack unrelated money questions", () => {
    expect(parseFastNetWorthIntent("should I buy Bitcoin?")).toBeNull();
  });
});
