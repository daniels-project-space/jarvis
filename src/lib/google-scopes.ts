// Keep Google OAuth consent deliberately narrow and reusable from both the
// Next.js server and Convex. This module intentionally has no Node or React
// dependencies so capability status can be computed at the Convex boundary.

export const GOOGLE_GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

// `calendar.events.owned` is enough for the authenticated account's primary
// calendar and cannot alter events on calendars merely shared with it.
export const GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE,
].join(" ");

function grantedScopes(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean));
}

export function hasGoogleScopes(scope: string, required: readonly string[]): boolean {
  const granted = grantedScopes(scope);
  return required.every((value) => granted.has(value));
}

export function googleCapabilities(scope: string) {
  return {
    gmail: hasGoogleScopes(scope, [GOOGLE_GMAIL_MODIFY_SCOPE, GOOGLE_GMAIL_COMPOSE_SCOPE]),
    calendar: hasGoogleScopes(scope, [GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE]),
  };
}
