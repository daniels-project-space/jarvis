import { describe, expect, it } from "vitest";
import {
  createLocalHandoverPromptContext,
  markdownDataBlock,
  normaliseLocalHandoverPrompt,
} from "./local-handover-prompt-context";

describe("local handover prompt context", () => {
  it("normalises, redacts, and bounds prompts before they enter a handover bundle", () => {
    const prompt = normaliseLocalHandoverPrompt(
      "\u0000Ship it\r\nAuthorization: Bearer test-token-123456789\r\nAPI_KEY=super-secret-value",
      { API_KEY: "super-secret-value" },
    );
    expect(prompt).toBe("Ship it\nAuthorization: Bearer [REDACTED]\nAPI_KEY=[REDACTED]");
  });

  it("makes a stable digest from the initial and latest user instructions", () => {
    const first = createLocalHandoverPromptContext({
      initialUserPrompt: "Implement the handover.",
      latestUserPrompt: "Also carry the last prompt.",
      captureMethod: "codex_app_server",
    });
    const second = createLocalHandoverPromptContext({
      initialUserPrompt: "Implement the handover.",
      latestUserPrompt: "Also carry the last prompt.",
      captureMethod: "codex_app_server",
    });
    const changed = createLocalHandoverPromptContext({
      initialUserPrompt: "Implement the handover.",
      latestUserPrompt: "Use the newest prompt before cutover.",
      captureMethod: "codex_app_server",
    });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).not.toBe(changed.digest);
  });

  it("uses a fence that cannot be closed by prompt data", () => {
    const block = markdownDataBlock("Do not run this:\n```\nrm -rf /\n```");
    expect(block.startsWith("````text\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
  });
});
