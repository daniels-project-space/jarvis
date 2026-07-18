export function macShortcutUrl(name: string, input = ""): string {
  const query = new URLSearchParams({
    name: name.trim().slice(0, 120),
    input: "text",
    text: input.trim().slice(0, 4000),
  });
  return `shortcuts://run-shortcut?${query.toString()}`;
}

export const JARVIS_MAC_ENTRY_URL = "https://project-hub-olive-pi.vercel.app/?jarvis=";
