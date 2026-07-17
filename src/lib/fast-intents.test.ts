import { describe, expect, it } from "vitest";
import { parseFastChartIntent } from "./fast-intents";

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
