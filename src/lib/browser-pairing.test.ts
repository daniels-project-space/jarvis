import { describe, expect, it } from "vitest";
import { extractPairingToken } from "./browser-pairing";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234";

describe("browser pairing recovery", () => {
  it("reads the passwordless capability from a Jarvis URL", () => {
    expect(extractPairingToken(`https://jarvis-orcin-six.vercel.app/#pair=${TOKEN}`)).toBe(TOKEN);
  });

  it("also accepts a copied capability token", () => {
    expect(extractPairingToken(TOKEN)).toBe(TOKEN);
  });

  it("rejects ordinary text and short values", () => {
    expect(extractPairingToken("my password")).toBeNull();
    expect(extractPairingToken("abc123")).toBeNull();
  });
});
