import { z } from "zod";

import { routeWork, suggestedAcceptanceCriteria } from "./routing";
import { selectCodexWorkPolicy } from "../lib/codex-work-router";
import { parseWorkModelTier } from "../lib/work-models";
import {
  TEAM_BY_SLUG,
  type AgentSlug,
  type ModelTier,
  type WorkRisk,
} from "./team";

export const workstreamSchema = z.object({
  label: z.string().min(3).max(80),
  task: z.string().min(12).max(4000),
  agentId: z.enum(["paul", "atlas", "iris", "maya", "chloe", "sentry"]),
  repo: z.string().nullable(),
  model: z.enum(["luna", "terra", "sol"]),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "ultra", "max"]),
  modelReason: z.string().min(1).max(300),
  readonly: z.boolean(),
  approvalRequired: z.boolean(),
  risk: z.enum(["low", "medium", "high", "consequential"]),
  acceptanceCriteria: z.array(z.string()).min(1).max(8),
});

export type ManagedWorkstream = z.infer<typeof workstreamSchema>;

export function normalizeWorkstream(input: {
  task: string;
  label?: string;
  repo?: string;
  model?: string;
  reasoningEffort?: string;
  agentId?: string;
  readonly?: boolean;
  approvalRequired?: boolean;
  risk?: string;
  acceptanceCriteria?: string[];
}): ManagedWorkstream {
  const route = routeWork(input.task, {
    repo: input.repo,
    requestedModel: input.model,
    readonly: input.readonly,
  });
  const requestedAgent = input.agentId as AgentSlug | undefined;
  const deterministicSpecialist = ["iris", "maya", "chloe", "sentry"].includes(route.agentId)
    ? route.agentId
    : null;
  const agentId = (
    deterministicSpecialist ?? (requestedAgent &&
    requestedAgent !== "jarvis" &&
    TEAM_BY_SLUG[requestedAgent]
      ? requestedAgent
      : route.agentId === "jarvis"
        ? "atlas"
        : route.agentId)
  ) as Exclude<AgentSlug, "jarvis">;
  const approvalRequired =
    input.approvalRequired === true ||
    route.approvalRequired ||
    input.risk === "consequential";
  const risk = (approvalRequired
    ? "consequential"
    : input.risk && ["low", "medium", "high"].includes(input.risk)
      ? input.risk
      : route.risk) as WorkRisk;
  const requestedModel = parseWorkModelTier(input.model);
  const routeFloor = route.modelFloor;
  const effectiveModelFloor = requestedModel === "sol" || routeFloor === "sol"
    ? "sol"
    : requestedModel === "terra" || routeFloor === "terra"
      ? "terra"
      : requestedModel;
  const modelPolicy = selectCodexWorkPolicy({
    task: input.task,
    role: agentId,
    repo: input.repo,
    readonly: input.readonly === true || approvalRequired,
    risk,
    requestedModel: effectiveModelFloor,
    requestedReasoningEffort: input.reasoningEffort,
  });
  return {
    label: (
      input.label ||
      `${TEAM_BY_SLUG[agentId].name} · ${TEAM_BY_SLUG[agentId].role}`
    ).slice(0, 80),
    task: input.task.slice(0, 4000),
    agentId,
    repo: input.repo ?? null,
    model: modelPolicy.model as ModelTier,
    reasoningEffort: modelPolicy.reasoningEffort,
    modelReason: modelPolicy.modelReason,
    readonly: input.readonly === true || route.readonly || approvalRequired || risk === "consequential",
    approvalRequired,
    risk,
    acceptanceCriteria: input.acceptanceCriteria?.length
      ? input.acceptanceCriteria.slice(0, 8)
      : suggestedAcceptanceCriteria(input.task, route),
  };
}
