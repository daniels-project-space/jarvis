import { describe, expect, it } from "vitest";
import {
  CODEX_REVIEW_WORKING_DIRECTORY,
  CODEX_MODEL_POLICY,
  codexConversationExecPrefix,
  codexExecPrefix,
  codexModelFor,
  codexReviewExecPrefix,
  normalizeReasoningEffort,
  pickConversationTier,
  shouldUseLunaFastLane,
} from "./model-policy";
import { withHostContext } from "../lib/host-context";

describe("subscription model policy", () => {
  it("maps increasing work tiers to the live Luna, Terra and Sol catalogue", () => {
    expect(CODEX_MODEL_POLICY).toEqual({
      luna: { model: "gpt-5.6-luna", effort: "low" },
      terra: { model: "gpt-5.6-terra", effort: "medium" },
      sol: { model: "gpt-5.6-sol", effort: "max" },
    });
  });

  it("routes conversation difficulty without spending frontier intelligence on reflexes", () => {
    expect(pickConversationTier("hello Jarvis")).toBe("luna");
    expect(pickConversationTier("Thanks, Jarvis!")).toBe("luna");
    expect(pickConversationTier("Hey Jarvis, what's on my calendar?")).toBe("luna");
    expect(pickConversationTier("Show me the weather in London")).toBe("luna");
    expect(pickConversationTier("Brainstorm a sharper product strategy for Jarvis and compare the trade-offs")).toBe("terra");
    expect(pickConversationTier("Trace the root cause of this multi-repo production outage from first principles")).toBe("sol");
  });

  it("does not route a substantive request to Luna merely because it starts with a greeting", () => {
    expect(pickConversationTier("Hey Jarvis, fix the loading spinner")).toBe("terra");
  });

  it("does not route short consequential instructions to the cheap reflex tier", () => {
    expect(pickConversationTier("Send the client a confirmation email")).toBe("terra");
    expect(pickConversationTier("Delete this upcoming calendar event")).toBe("terra");
    expect(pickConversationTier("Deploy this to production")).toBe("terra");
    // Analytical and explicitly negated wording remains cheap when it does
    // not request an external effect.
    expect(pickConversationTier("Do not send the client an email; just show a draft")).toBe("luna");
  });

  it("reserves the stripped Luna thread for exact social reflexes", () => {
    expect(shouldUseLunaFastLane("hello Jarvis", "luna")).toBe(true);
    expect(shouldUseLunaFastLane("Thanks, Jarvis!", "luna")).toBe(true);
    // These stay on Luna, but need the normal capability briefing and the
    // thread that retains context for a live-data or visual follow-up.
    expect(pickConversationTier("What's on my calendar?")).toBe("luna");
    expect(shouldUseLunaFastLane("What's on my calendar?", "luna")).toBe(false);
    expect(shouldUseLunaFastLane("Show me the weather in London", "luna")).toBe(false);
    expect(shouldUseLunaFastLane("hello Jarvis", "terra")).toBe(false);
  });

  it("does not treat bounded host-screen evidence as user-request complexity", () => {
    const text = withHostContext("What is the title of this page?", {
      url: "https://project-hub.example",
      title: "Project Hub",
      text: "dashboard evidence ".repeat(600),
    });
    expect(pickConversationTier(text)).toBe("luna");
  });

  it("falls back unknown tiers to balanced work instead of the highest-cost tier", () => {
    expect(codexModelFor("unknown")).toBe(CODEX_MODEL_POLICY.terra);
  });

  it("never sends the unsupported plain gpt-5.6 model to a ChatGPT account", () => {
    for (const tier of ["luna", "terra", "sol", "unknown"]) {
      const args = codexExecPrefix(tier);
      expect(args).not.toContain("gpt-5.6");
      expect(args[0]).toBe("--search");
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });

  it("allows Goal Mode to run Terra/high without changing the default tier policy", () => {
    const args = codexExecPrefix("terra", "high");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain("gpt-5.6-terra");
    expect(normalizeReasoningEffort("invented", "medium")).toBe("medium");
  });

  it("launches receipt-only supervisor review from /app without mutation or tool authority", () => {
    const args = codexReviewExecPrefix("terra");
    expect(CODEX_REVIEW_WORKING_DIRECTORY).toBe("/app");
    expect(args).toContain("read-only");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain("--search");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "computer_use", "multi_agent"]) {
      expect(args).toContain(feature);
      expect(args[args.indexOf(feature) - 1]).toBe("--disable");
    }
  });

  it("uses the lean subscription runtime only for foreground conversation", () => {
    for (const tier of ["luna", "terra", "sol", "unknown"]) {
      const args = codexConversationExecPrefix(tier);
      expect(args).toContain(codexModelFor(tier).model);
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--skip-git-repo-check");
      expect(args).toContain("danger-full-access");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("gpt-5.6");
    }
  });
});
