import { describe, expect, it } from "vitest";
import { NarrationLedger, narrationClaim } from "./narration";

describe("narration ownership", () => {
  it("allows one owner for an exact turn range", () => {
    const ledger = new NarrationLedger();
    const claim = narrationClaim("turn-1", "First sentence. Second sentence.", 0, 15);
    expect(ledger.claim(claim, 1_000)).toBe(true);
    expect(ledger.claim(claim, 1_001)).toBe(false);
  });

  it("keeps streamed and final-tail ranges independent", () => {
    const ledger = new NarrationLedger();
    const text = "First sentence. Second sentence.";
    expect(ledger.claim(narrationClaim("turn-1", text, 0, 15))).toBe(true);
    expect(ledger.claim(narrationClaim("turn-1", text, 15, text.length))).toBe(true);
  });

  it("does not confuse a corrected snapshot with the old text", () => {
    const ledger = new NarrationLedger();
    expect(ledger.claim(narrationClaim("turn-1", "Price is ten.", 0, 13))).toBe(true);
    expect(ledger.claim(narrationClaim("turn-1", "Price is nine.", 0, 13))).toBe(true);
  });
});

