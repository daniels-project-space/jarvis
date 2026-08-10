import { describe, expect, it } from "vitest";
import { extractCodexThreadUserPrompts } from "./local-handover-codex-prompts";

describe("Codex app-server prompt extraction", () => {
  const marker = "JARVIS_HANDOVER_MARKER:abc";
  const thread = {
    thread: {
      id: "thread-1",
      cwd: "/work/project",
      turns: [{
        items: [
          { type: "userMessage", content: [{ type: "text", text: `Read the bundle. ${marker}` }] },
          { type: "agentMessage", content: [{ type: "text", text: "I will." }] },
          { type: "userMessage", content: [{ type: "text", text: "Keep the existing changes." }] },
          { type: "userMessage", content: [{ type: "text", text: "Run the focused tests too." }, { type: "image" }] },
        ],
      }],
    },
  };

  it("uses only canonical user messages and excludes the supervisor bootstrap marker", () => {
    expect(extractCodexThreadUserPrompts(thread, {
      threadId: "thread-1",
      cwd: "/work/project",
      launchMarker: marker,
      requireLaunchMarker: true,
    })).toEqual({
      threadId: "thread-1",
      initialUserPrompt: "Keep the existing changes.",
      latestUserPrompt: "Run the focused tests too.",
      omittedNonTextContent: true,
    });
  });

  it("fails closed when a marker candidate belongs to a different checkout", () => {
    expect(extractCodexThreadUserPrompts(thread, {
      threadId: "thread-1",
      cwd: "/other/project",
      launchMarker: marker,
      requireLaunchMarker: true,
    })).toBeNull();
  });
});
