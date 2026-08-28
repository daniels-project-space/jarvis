import { describe, expect, it } from "vitest";
import { googleOAuthReturnNotice } from "./google-oauth-return";

describe("googleOAuthReturnNotice", () => {
  it("shows a clear completion message only for the callback success status", () => {
    expect(googleOAuthReturnNotice("?google_oauth=connected")).toEqual({
      tone: "success",
      message: "Google account connected. Checking Gmail access…",
    });
    expect(googleOAuthReturnNotice("?google_oauth=connected&google_oauth_detail=ignored")).not.toBeNull();
  });

  it("keeps configuration and provider errors non-secret", () => {
    expect(googleOAuthReturnNotice("?google_oauth=error&google_oauth_detail=not_configured")).toMatchObject({
      tone: "error",
      message: expect.stringMatching(/not configured/i),
    });
    expect(googleOAuthReturnNotice("?google_oauth=error&google_oauth_detail=provider%20credential%20leak")).toEqual({
      tone: "error",
      message: "Google connection was not completed. Please try again.",
    });
  });

  it("ignores unrelated URLs", () => {
    expect(googleOAuthReturnNotice("?other=value")).toBeNull();
  });
});
