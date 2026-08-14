export type GoogleOAuthReturnNotice = {
  tone: "success" | "error";
  message: string;
};

/**
 * Converts the deliberately opaque OAuth callback parameters into a useful,
 * non-secret message for the owner. Unknown provider details stay private so
 * redirect URLs never become an error-reporting channel.
 */
export function googleOAuthReturnNotice(search: string): GoogleOAuthReturnNotice | null {
  const params = new URLSearchParams(search);
  const status = params.get("google_oauth");
  if (status === "connected") {
    return { tone: "success", message: "Google account connected. Checking Gmail and Google Calendar access…" };
  }
  if (status !== "error") return null;
  if (params.get("google_oauth_detail") === "not_configured") {
    return { tone: "error", message: "Google connection is not configured yet. Add its secure settings, then connect." };
  }
  return { tone: "error", message: "Google connection was not completed. Please try again." };
}
