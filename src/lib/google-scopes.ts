// Keep Google OAuth consent deliberately narrow and reusable from both the
// Next.js server and Convex. This module intentionally has no Node or React
// dependencies so capability status can be computed at the Convex boundary.

export const GOOGLE_GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
// Older connections may have this broader historical grant. It remains a
// compatibility capability only; new consent never requests it.
export const GOOGLE_GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
].join(" ");

const GOOGLE_GMAIL_COMPATIBILITY_SCOPES = new Set([
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_GMAIL_COMPOSE_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
]);

function grantedScopes(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean));
}

export function hasGoogleScopes(scope: string, required: readonly string[]): boolean {
  const granted = grantedScopes(scope);
  return required.every((value) => granted.has(value));
}

/**
 * Jarvis deliberately retains Google only as Gmail transport. A refresh token
 * carrying Calendar, Drive, profile, or any other Google grant must be
 * reconnected rather than stored or reused through this app.
 */
export function hasOnlyGoogleGmailScopes(scope: string): boolean {
  const granted = grantedScopes(scope);
  return (
    granted.size > 0 &&
    [...granted].every((value) => GOOGLE_GMAIL_COMPATIBILITY_SCOPES.has(value))
  );
}

export function googleCapabilities(scope: string) {
  return {
    gmail:
      hasOnlyGoogleGmailScopes(scope) &&
      (hasGoogleScopes(scope, [GOOGLE_GMAIL_READONLY_SCOPE, GOOGLE_GMAIL_COMPOSE_SCOPE]) ||
        hasGoogleScopes(scope, [GOOGLE_GMAIL_MODIFY_SCOPE])),
  };
}
