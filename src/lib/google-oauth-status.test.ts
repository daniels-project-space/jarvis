import { describe, expect, it } from "vitest";
import { googleOAuthServerStatusFromReadiness, googleOAuthStatusPresentation } from "./google-oauth-status";

describe("Google OAuth readiness presentation", () => {
  it("does not offer a broken connection flow when server OAuth setup is absent", () => {
    expect(googleOAuthStatusPresentation("needs_setup", "connected")).toMatchObject({
      label: "needs setup",
      tone: "attention",
      action: "none",
      hint: expect.stringContaining("production client, secret, and token-encryption key"),
    });
  });

  it("keeps an incomplete grant separate from a missing account", () => {
    expect(googleOAuthStatusPresentation("configured", "needs_reconnect")).toMatchObject({
      label: "reconnect",
      action: "reconnect",
    });
    expect(googleOAuthStatusPresentation("configured", "disconnected")).toMatchObject({
      label: "connect",
      action: "connect",
    });
  });

  it("offers a direct recovery path when the saved encrypted connection is unreadable", () => {
    expect(googleOAuthStatusPresentation("needs_reconnect", "connected")).toMatchObject({
      label: "reconnect",
      tone: "attention",
      action: "reconnect",
      hint: expect.stringMatching(/cannot read the saved Google connection/i),
    });
  });

  it("fails closed when the secure server cannot read stored connection readiness", () => {
    const server = googleOAuthServerStatusFromReadiness(true, "unavailable");
    expect(server).toBe("unavailable");
    expect(googleOAuthStatusPresentation(server, "connected")).toMatchObject({
      label: "check later",
      tone: "attention",
      action: "none",
    });
  });

  it("only calls Gmail and Calendar ready after both server and account checks pass", () => {
    expect(googleOAuthStatusPresentation("configured", "connected")).toMatchObject({
      label: "connected ✓",
      tone: "ready",
      action: "none",
    });
    expect(googleOAuthStatusPresentation("unavailable", "connected")).toMatchObject({
      label: "check later",
      tone: "attention",
    });
  });
});
