export const CODEX_MODEL_POLICY = {
  // The names intentionally describe workload complexity, not providers. This
  // lets Mastra route work once while the subscription runtime chooses the
  // best currently enabled Codex model for that tier.
  haiku: { model: "gpt-5.6-luna", effort: "low" },
  sonnet: { model: "gpt-5.6-terra", effort: "medium" },
  // Sol is the frontier agentic model in the live ChatGPT/Codex catalogue.
  // `max` keeps the highest tier genuinely high intelligence without `ultra`'s
  // own automatic delegation competing with Jarvis's supervised work graph.
  opus: { model: "gpt-5.6-sol", effort: "max" },
} as const;

export type WorkModelTier = keyof typeof CODEX_MODEL_POLICY;
export type CodexModelSelection = (typeof CODEX_MODEL_POLICY)[WorkModelTier];

export function codexModelFor(tier: string): CodexModelSelection {
  return CODEX_MODEL_POLICY[tier as WorkModelTier] ?? CODEX_MODEL_POLICY.sonnet;
}

export function codexExecPrefix(tier: string): string[] {
  const selected = codexModelFor(tier);
  return [
    "exec",
    "--model",
    selected.model,
    "--config",
    `model_reasoning_effort=\"${selected.effort}\"`,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
}

export function pickConversationTier(text: string): WorkModelTier {
  const value = text.toLowerCase().trim();
  if (
    value.length > 700 ||
    /\b(root cause|multi[- ]?(repo|project|file)|architecture migration|security incident|production outage|think (really |very )?hard|from first principles|deep dive)\b/.test(value)
  ) return "opus";
  if (
    value.length <= 60 &&
    /^(hi|hey|hello|yo|thanks|thank you|ok|okay|sup|morning|evening|good (morning|evening|day)|what'?s up|how are you)\b/.test(value)
  ) return "haiku";
  if (
    value.length <= 80 &&
    !/\b(brainstorm|compare|design|plan|strategy|analy[sz]e|investigate|recommend|fix|build|create)\b/.test(value)
  ) return "haiku";
  return "sonnet";
}
