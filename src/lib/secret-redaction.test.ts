import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./secret-redaction";

describe("agent output secret redaction", () => {
  it("removes known runtime values and provider token prefixes", () => {
    const secret = "test-secret-value-123";
    const output = redactSensitiveText(
      `AUTH_TOKEN=${secret} BROWSERBASE_API_KEY\\\":\\\"bb_live_exampleToken123456`,
      { AUTH_TOKEN: secret },
    );
    expect(output).not.toContain(secret);
    expect(output).not.toContain("bb_live_");
    expect(output).toContain("REDACTED");
  });

  it("leaves ordinary evidence untouched", () => {
    expect(redactSensitiveText("tests 25/25 · production HTTP 200")).toBe("tests 25/25 · production HTTP 200");
  });
});
