type UnknownRecord = Record<string, unknown>;

export type CodexThreadUserPrompts = Readonly<{
  threadId: string;
  initialUserPrompt?: string;
  latestUserPrompt?: string;
  omittedNonTextContent: boolean;
}>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function textFromContent(value: unknown): { text: string; omittedNonTextContent: boolean } {
  if (typeof value === "string") return { text: value, omittedNonTextContent: false };
  if (!Array.isArray(value)) return { text: "", omittedNonTextContent: value !== undefined };
  let text = "";
  let omittedNonTextContent = false;
  for (const entry of value) {
    const part = record(entry);
    if (part?.type === "text" && typeof part.text === "string") text += part.text;
    else omittedNonTextContent = true;
  }
  return { text, omittedNonTextContent };
}

/**
 * Extracts only canonical userMessage items from a Codex app-server
 * thread/read response. The caller supplies either a previously verified
 * thread id or a launch marker; this function never chooses a generic recent
 * thread on its own.
 */
export function extractCodexThreadUserPrompts(
  value: unknown,
  expected: Readonly<{ threadId: string; cwd: string; launchMarker?: string; requireLaunchMarker?: boolean }>,
): CodexThreadUserPrompts | null {
  const response = record(value);
  const thread = record(response?.thread ?? value);
  if (!thread || thread.id !== expected.threadId || thread.cwd !== expected.cwd || !Array.isArray(thread.turns)) return null;

  const messages: string[] = [];
  let omittedNonTextContent = false;
  for (const rawTurn of thread.turns) {
    const turn = record(rawTurn);
    if (!Array.isArray(turn?.items)) continue;
    for (const rawItem of turn.items) {
      const item = record(rawItem);
      if (item?.type !== "userMessage") continue;
      const extracted = textFromContent(item.content);
      omittedNonTextContent ||= extracted.omittedNonTextContent;
      if (extracted.text.trim()) messages.push(extracted.text);
    }
  }

  const markerFound = Boolean(expected.launchMarker && messages.some((message) => message.includes(expected.launchMarker!)));
  if (expected.requireLaunchMarker && !markerFound) return null;
  const userMessages = expected.launchMarker
    ? messages.filter((message) => !message.includes(expected.launchMarker!))
    : messages;
  return {
    threadId: expected.threadId,
    initialUserPrompt: userMessages[0],
    latestUserPrompt: userMessages.at(-1),
    omittedNonTextContent,
  };
}
