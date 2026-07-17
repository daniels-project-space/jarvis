import { describe, expect, it } from "vitest";
import { validPairingRequestBearer } from "./pairing-request-auth";

const TOKEN = "pairing-request-token-that-is-at-least-32-characters";

describe("external pairing request authorization", () => {
  it("accepts the exact dedicated bearer", () => {
    expect(validPairingRequestBearer(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects missing, short and different bearers", () => {
    expect(validPairingRequestBearer(undefined, TOKEN)).toBe(false);
    expect(validPairingRequestBearer("short", "short")).toBe(false);
    expect(validPairingRequestBearer(TOKEN, `${TOKEN.slice(0, -1)}x`)).toBe(false);
  });
});
