import { normalizeWorkModelTier, type WorkModelTier } from "../lib/work-models";
import { visibleTurnText } from "../lib/host-context";

export const CODEX_MODEL_POLICY = {
  luna: { model: "gpt-5.6-luna", effort: "low" },
  terra: { model: "gpt-5.6-terra", effort: "medium" },
  // Sol is the frontier agentic model in the live ChatGPT/Codex catalogue.
  // `max` keeps the highest tier genuinely high intelligence without `ultra`'s
  // own automatic delegation competing with Jarvis's supervised work graph.
  sol: { model: "gpt-5.6-sol", effort: "max" },
} as const;

export type CodexModelSelection = (typeof CODEX_MODEL_POLICY)[WorkModelTier];
export type CodexReasoningEffort = "low" | "medium" | "high" | "max";

export function normalizeReasoningEffort(value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "max" ? value : fallback;
}

export function codexModelFor(tier: string): CodexModelSelection {
  return CODEX_MODEL_POLICY[normalizeWorkModelTier(tier)];
}

export function codexExecPrefix(tier: string, effort?: unknown): string[] {
  const selected = codexModelFor(tier);
  const reasoningEffort = normalizeReasoningEffort(effort, selected.effort);
  return [
    "--search",
    "exec",
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=\"${reasoningEffort}\"`,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
}

export const CODEX_REVIEW_WORKING_DIRECTORY = "/app";

// Supervisor review consumes a controller-signed receipt, not a writable
// specialist checkout. It needs model reasoning only: no shell, web, apps,
// plugins, hooks or child agents. Authentication remains in the Codex parent
// process while the shell environment policy would pass no variables even if
// a future CLI regression accidentally reintroduced a command tool.
export function codexReviewExecPrefix(tier: string, effort?: unknown): string[] {
  const selected = codexModelFor(tier);
  const reasoningEffort = normalizeReasoningEffort(effort, selected.effort);
  return [
    "exec",
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=\"${reasoningEffort}\"`,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--strict-config",
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    "project_doc_max_bytes=0",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "hooks",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "multi_agent",
  ];
}

// Foreground conversation already supplies its own persona, policy and
// capability bridge. Skipping repository/user bootstrap avoids loading the
// general Codex plugin + MCP stack on every short turn while retaining full
// shell access for Jarvis's private tool endpoint. Durable coding agents keep
// the broader codexExecPrefix above.
export function codexConversationExecPrefix(tier: string): string[] {
  const selected = codexModelFor(tier);
  return [
    "exec",
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=\"${selected.effort}\"`,
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  ];
}

export function pickConversationTier(text: string): WorkModelTier {
  // Host screen evidence can be thousands of characters. It is useful to the
  // answer, but it is not Daniel's request and must not inflate a simple page
  // question into the frontier tier.
  const value = visibleTurnText(text).toLowerCase().trim();
  if (
    value.length > 700 ||
    /\b(root cause|multi[- ]?(repo|project|file)|architecture migration|security incident|production outage|think (really |very )?hard|from first principles|deep dive)\b/.test(value)
  ) return "sol";
  if (
    value.length <= 60 &&
    /^(hi|hey|hello|yo|thanks|thank you|ok|okay|sup|morning|evening|good (morning|evening|day)|what'?s up|how are you)\b/.test(value)
  ) return "luna";
  if (
    value.length <= 80 &&
    !/\b(brainstorm|compare|design|plan|strategy|analy[sz]e|investigate|recommend|fix|build|create)\b/.test(value)
  ) return "luna";
  return "terra";
}
