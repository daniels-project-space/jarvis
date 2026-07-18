import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_POLICY,
  codexConversationExecPrefix,
  codexExecPrefix,
  codexModelFor,
  pickConversationTier,
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
    expect(pickConversationTier("Show me the weather in London")).toBe("luna");
    expect(pickConversationTier("Brainstorm a sharper product strategy for Jarvis and compare the trade-offs")).toBe("terra");
    expect(pickConversationTier("Trace the root cause of this multi-repo production outage from first principles")).toBe("sol");
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
