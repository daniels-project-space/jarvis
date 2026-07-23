import { routeWork } from "../mastra/routing";

const DIRECT_AGENT_IDS = ["paul", "atlas", "iris", "maya", "sentry"] as const;
type DirectAgentId = (typeof DIRECT_AGENT_IDS)[number];

/** Normalize foreground tool arguments before the shared work policy runs. */
export function routeDirectAgentLaunch(task: string, input: {
  repo?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  agentId?: unknown;
  readonly?: unknown;
  tools?: unknown;
}) {
  const requested = String(input.agentId ?? "");
  const requestedAgent = (DIRECT_AGENT_IDS as readonly string[]).includes(requested)
    ? requested as DirectAgentId
    : undefined;
  const requestedTools = Array.isArray(input.tools) ? input.tools.map(String) : undefined;
  const route = routeWork(task, {
    repo: input.repo ? String(input.repo) : undefined,
    requestedModel: input.model ? String(input.model) : undefined,
    requestedReasoningEffort: input.reasoningEffort ? String(input.reasoningEffort) : undefined,
    readonly: typeof input.readonly === "boolean" ? input.readonly : undefined,
    tools: requestedTools,
    role: requestedAgent,
  });
  return { route, agentId: requestedAgent ?? route.agentId, requestedTools };
}
