import { describe, expect, it } from "vitest";
import {
  CODEX_REVIEW_WORKING_DIRECTORY,
  CODEX_MODEL_POLICY,
  codexAppServerArgs,
  codexConversationExecPrefix,
  codexExecPrefix,
  codexModelFor,
  codexReviewExecPrefix,
  normalizeReasoningEffort,
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

  it("never sends the unsupported plain gpt-5.6 model or a dangerous sandbox to a specialist", () => {
    for (const tier of ["luna", "terra", "sol", "unknown"]) {
      const args = codexExecPrefix(tier);
      expect(args).not.toContain("gpt-5.6");
      expect(args[0]).toBe("--search");
      expect(args).toContain("workspace-write");
      expect(args).toContain("features.use_legacy_landlock=true");
      expect(args).toContain("sandbox_workspace_write.network_access=false");
      expect(args).toContain('shell_environment_policy.inherit="none"');
      expect(args).not.toContain("danger-full-access");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
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

  it("keeps fallback conversation reasoning-only", () => {
    for (const tier of ["luna", "terra", "sol", "unknown"]) {
      const args = codexConversationExecPrefix(tier);
      expect(args).toContain(codexModelFor(tier).model);
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--skip-git-repo-check");
      expect(args).toContain("read-only");
      expect(args).toContain('shell_environment_policy.inherit="none"');
      for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "computer_use", "multi_agent"]) {
        expect(args[args.indexOf(feature) - 1]).toBe("--disable");
      }
      expect(args).not.toContain("danger-full-access");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("gpt-5.6");
    }
  });

  it("starts the foreground app server with process-level read-only defaults", () => {
    const args = codexAppServerArgs();
    expect(args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(args).not.toContain("danger-full-access");
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use", "computer_use", "multi_agent"]) {
      expect(args[args.indexOf(feature) - 1]).toBe("--disable");
    }
  });
});
