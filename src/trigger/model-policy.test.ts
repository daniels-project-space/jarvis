import { describe, expect, it } from "vitest";
import { CODEX_MODEL_POLICY, codexExecPrefix, codexModelFor, pickConversationTier } from "./model-policy";

describe("subscription model policy", () => {
  it("maps increasing work tiers to the live Luna, Terra and Sol catalogue", () => {
    expect(CODEX_MODEL_POLICY).toEqual({
      haiku: { model: "gpt-5.6-luna", effort: "low" },
      sonnet: { model: "gpt-5.6-terra", effort: "medium" },
      opus: { model: "gpt-5.6-sol", effort: "max" },
    });
  });

  it("routes conversation difficulty without spending frontier intelligence on reflexes", () => {
    expect(pickConversationTier("hello Jarvis")).toBe("haiku");
    expect(pickConversationTier("Show me the weather in London")).toBe("haiku");
    expect(pickConversationTier("Brainstorm a sharper product strategy for Jarvis and compare the trade-offs")).toBe("sonnet");
    expect(pickConversationTier("Trace the root cause of this multi-repo production outage from first principles")).toBe("opus");
  });

  it("falls back unknown tiers to balanced work instead of the highest-cost tier", () => {
    expect(codexModelFor("unknown")).toBe(CODEX_MODEL_POLICY.sonnet);
  });

  it("never sends the unsupported plain gpt-5.6 model to a ChatGPT account", () => {
    for (const tier of ["haiku", "sonnet", "opus", "unknown"]) {
      const args = codexExecPrefix(tier);
      expect(args).not.toContain("gpt-5.6");
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });
});
