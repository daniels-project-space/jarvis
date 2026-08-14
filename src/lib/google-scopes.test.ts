import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  googleCapabilities,
} from "./google-scopes";

describe("Google OAuth scope policy", () => {
  it("requests the smallest set needed to read, draft/send, and manage owned calendar events", () => {
    expect(GOOGLE_OAUTH_SCOPES.split(" ")).toEqual([
      GOOGLE_GMAIL_READONLY_SCOPE,
      GOOGLE_GMAIL_COMPOSE_SCOPE,
      GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE,
    ]);
  });

  it("requires the least-privilege Gmail grants before enabling Gmail tools", () => {
    expect(googleCapabilities(`${GOOGLE_GMAIL_READONLY_SCOPE} ${GOOGLE_GMAIL_COMPOSE_SCOPE}`)).toEqual({
      gmail: true,
      calendar: false,
    });
    expect(googleCapabilities(`https://www.googleapis.com/auth/gmail.modify ${GOOGLE_GMAIL_COMPOSE_SCOPE}`)).toEqual({
      gmail: false,
      calendar: false,
    });
  });
});
