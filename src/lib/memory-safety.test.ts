import { describe, expect, it } from "vitest";
import { containsLikelySecret, redactSecrets, safeMemoryNote } from "./memory-safety";

describe("memory secret safety", () => {
  it("allows durable non-secret memories", () => {
    expect(safeMemoryNote("Reply style", "Daniel prefers concise replies.")).toEqual({
      title: "Reply style",
      body: "Daniel prefers concise replies.",
    });
    expect(safeMemoryNote("Credential boundary", "The password manager is configured and the API key is stored securely.")).not.toBeNull();
  });

  it.each([
    "API_KEY=abcdefghijklmnopqrstuvwxyz123456",
    "Bearer abcdefghijklmnopqrstuvwxyz123456",
    "password is correct-horse-battery-staple",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
  ])("rejects likely credentials: %s", (value) => {
    expect(containsLikelySecret(value)).toBe(true);
    expect(safeMemoryNote("Credential", value)).toBeNull();
  });

  it("redacts secrets before model extraction", () => {
    expect(redactSecrets("API_KEY=abcdefghijklmnopqrstuvwxyz123456")).toBe("API_KEY=[REDACTED]");
  });
});
