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

const MODEL_ONLY_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "computer_use",
  "multi_agent",
] as const;

const SPECIALIST_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "computer_use",
  "multi_agent",
] as const;

function disabledFeatures(features: readonly string[]): string[] {
  return features.flatMap((feature) => ["--disable", feature]);
}

function specialistShellEnvironment(workspace: string, path: string): string {
  const values = {
    PATH: path || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: workspace,
    LANG: "C.UTF-8",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  return `shell_environment_policy.set={ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ")} }`;
}

/**
 * The only model-child profile with command tools. The outer launcher adds a
 * user/PID namespace; this classic workspace-write policy deliberately stays
 * legacy-round-trippable so `features.use_legacy_landlock` cannot select
 * Bubblewrap again.
 */
export function codexExecPrefix(
  tier: string,
  effort?: unknown,
  workspace = process.cwd(),
  path = process.env.PATH ?? "",
): string[] {
  const selected = codexModelFor(tier);
  const reasoningEffort = normalizeReasoningEffort(effort, selected.effort);
  return [
    "--search",
    "exec",
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=\"${reasoningEffort}\"`,
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--strict-config",
    "--cd",
    workspace,
    "--config",
    'approval_policy="never"',
    "--config",
    "features.use_legacy_landlock=true",
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "--config",
    "allow_login_shell=false",
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    specialistShellEnvironment(workspace, path),
    ...disabledFeatures(SPECIALIST_DISABLED_FEATURES),
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
    ...disabledFeatures(MODEL_ONLY_FEATURES),
  ];
}

// Memory and fallback foreground execs are reasoning-only. Jarvis capabilities
// are served by the controller-owned dynamic-tool bridge, never a shell.
export function codexConversationExecPrefix(tier: string): string[] {
  return codexReviewExecPrefix(tier);
}

/** Strict process-level defaults for the warm foreground app-server. */
export function codexAppServerArgs(): string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    "--config",
    'approval_policy="never"',
    "--config",
    'sandbox_mode="read-only"',
    "--config",
    'web_search="disabled"',
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    "project_doc_max_bytes=0",
    ...disabledFeatures(MODEL_ONLY_FEATURES),
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
