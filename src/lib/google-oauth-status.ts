export type GoogleOAuthServerStatus = "checking" | "configured" | "needs_setup" | "needs_reconnect" | "unavailable";

export type GoogleOAuthConnectionStatus = "checking" | "disconnected" | "connected" | "needs_reconnect";

export function googleOAuthStatusPresentation(
  server: GoogleOAuthServerStatus,
  connection: GoogleOAuthConnectionStatus,
): {
  label: string;
  hint: string;
  tone: "neutral" | "ready" | "attention";
  action: "none" | "connect" | "reconnect";
} {
  // A stored encrypted account alone is not enough to make a live Gmail or
  // Calendar request: the Next server also needs its OAuth client and the
  // stable AES key that can decrypt the account refresh token. Surface that
  // dependency before offering a connect/reconnect action that cannot work.
  switch (server) {
    case "needs_setup":
      return {
        label: "needs setup",
        hint: "Google OAuth needs its production client, secret, and token-encryption key before Gmail or Google Calendar can run.",
        tone: "attention",
        action: "none",
      };
    case "needs_reconnect":
      return {
        label: "reconnect",
        hint: "Jarvis cannot read the saved Google connection with the current secure settings. Reconnect Google to restore Gmail and Google Calendar access.",
        tone: "attention",
        action: "reconnect",
      };
    case "unavailable":
      return {
        label: "check later",
        hint: "Google connection readiness could not be checked. Jarvis will not claim Gmail or Google Calendar is ready.",
        tone: "attention",
        action: "none",
      };
    case "checking":
      return {
        label: "checking…",
        hint: "Checking the secure Google connection and server setup.",
        tone: "neutral",
        action: "none",
      };
    case "configured":
      switch (connection) {
        case "connected":
          return {
            label: "connected ✓",
            hint: "Gmail read/draft and protected Google Calendar actions are ready.",
            tone: "ready",
            action: "none",
          };
        case "needs_reconnect":
          return {
            label: "reconnect",
            hint: "Reconnect Google to grant the limited Gmail and Google Calendar permissions Jarvis needs.",
            tone: "attention",
            action: "reconnect",
          };
        case "disconnected":
          return {
            label: "connect",
            hint: "Gmail read/draft and protected Google Calendar are ready to connect.",
            tone: "neutral",
            action: "connect",
          };
        case "checking":
          return {
            label: "checking…",
            hint: "Checking whether a Google account is connected.",
            tone: "neutral",
            action: "none",
          };
      }
  }
}
