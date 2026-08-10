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

  it("redacts authorization values and private-key material without leaving the credential behind", () => {
    const output = redactSensitiveText(
      "Authorization: Bearer handover-token-123456\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    );
    expect(output).toContain("Authorization: Bearer [REDACTED]");
    expect(output).toContain("[REDACTED_PRIVATE_KEY]");
    expect(output).not.toContain("handover-token-123456");
  });

  it("redacts managed-session JWTs and refresh-token assignments", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJleHAiOjE4MDAwMDAwMDB9.signature123";
    const refresh = "managed-refresh-value-123456";
    const output = redactSensitiveText(`access_token=${jwt} refresh_token=${refresh}`);
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(refresh);
    expect(output).toContain("REDACTED");
  });

  it("redacts temporary R2 session credentials and parent access identifiers", () => {
    const session = "temporary-session-credential-123456";
    const parent = "parent-access-key-identifier-123456";
    const output = redactSensitiveText(
      `session_token=${session} access_key_id=${parent}`,
      { AWS_SESSION_TOKEN: session, R2_PARENT_ACCESS_KEY_ID: parent },
    );
    expect(output).not.toContain(session);
    expect(output).not.toContain(parent);
    expect(output.match(/REDACTED/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
