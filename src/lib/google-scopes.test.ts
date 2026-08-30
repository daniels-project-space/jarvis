import { describe, expect, it } from "vitest";
import {
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  googleCapabilities,
  hasOnlyGoogleGmailScopes,
} from "./google-scopes";

describe("Google OAuth scope policy", () => {
  it("requests the smallest set needed for Gmail read and draft actions", () => {
    expect(GOOGLE_OAUTH_SCOPES.split(" ")).toEqual([
      GOOGLE_GMAIL_READONLY_SCOPE,
      GOOGLE_GMAIL_COMPOSE_SCOPE,
    ]);
  });

  it("accepts the least-privilege grant and keeps a historical broader grant working", () => {
    expect(googleCapabilities(`${GOOGLE_GMAIL_READONLY_SCOPE} ${GOOGLE_GMAIL_COMPOSE_SCOPE}`)).toEqual({
      gmail: true,
    });
    expect(googleCapabilities(`https://www.googleapis.com/auth/gmail.modify ${GOOGLE_GMAIL_COMPOSE_SCOPE}`)).toEqual({
      gmail: true,
    });
  });

  it("rejects every non-Gmail Google grant, including Calendar", () => {
    const calendarScope = "https://www.googleapis.com/auth/calendar.events";
    const gmailWithCalendar = `${GOOGLE_GMAIL_READONLY_SCOPE} ${GOOGLE_GMAIL_COMPOSE_SCOPE} ${calendarScope}`;

    expect(hasOnlyGoogleGmailScopes(gmailWithCalendar)).toBe(false);
    expect(googleCapabilities(gmailWithCalendar)).toEqual({ gmail: false });
    expect(hasOnlyGoogleGmailScopes(GOOGLE_GMAIL_MODIFY_SCOPE)).toBe(true);
  });
});
