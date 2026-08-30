export const CODEX_AUTH_ENROLLMENT_CONFIRMATION =
  "Reconnect my ChatGPT subscription";

// Codex device enrollment is the only supported remote/headless login path.
// Keep this fixed so the browser control can open the verified OpenAI origin
// synchronously, before any popup blocker loses the user's click gesture.
export const CODEX_DEVICE_AUTH_URI =
  "https://auth.openai.com/codex/device" as const;

export const CODEX_AUTH_GUIDE_PATH = "/auth/chatgpt" as const;

export function openCodexAuthGuideWindow(
  openWindow: (
    url: typeof CODEX_AUTH_GUIDE_PATH,
    target: string,
    features: string,
  ) => Window | null,
): Window | null {
  return openWindow(
    CODEX_AUTH_GUIDE_PATH,
    "jarvis-chatgpt-auth",
    "popup,width=560,height=720",
  );
}
