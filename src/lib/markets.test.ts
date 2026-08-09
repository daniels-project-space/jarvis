import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveAsset } from "./markets";

describe("market asset resolution", () => {
  it.each([
    ["bitcoin", "Bitcoin", "BTCUSDT"],
    ["ETHUSDT", "Ethereum", "ETHUSDT"],
    ["sui", "Sui", "SUIUSDT"],
    ["toncoin", "Toncoin", "TONUSDT"],
    ["shiba inu", "Shiba Inu", "SHIBUSDT"],
  ])("keeps crypto names and pairs on the crypto data path: %s", (input, label, pair) => {
    expect(resolveAsset(input)).toMatchObject({ kind: "crypto", label, binance: pair });
  });

  it("still resolves an ordinary ticker as an equity", () => {
    expect(resolveAsset("AAPL")).toMatchObject({ kind: "stock", yahoo: "AAPL" });
  });
});
