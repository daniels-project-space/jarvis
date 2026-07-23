import { z } from "zod";

import { routeWork, suggestedAcceptanceCriteria } from "./routing";
import {
  TEAM_BY_SLUG,
  type AgentSlug,
  type ModelTier,
  type WorkRisk,
} from "./team";

export const workstreamSchema = z.object({
  label: z.string().min(3).max(80),
  task: z.string().min(12).max(4000),
  agentId: z.enum(["paul", "atlas", "iris", "maya", "sentry"]),
  repo: z.string().nullable(),
  model: z.enum(["luna", "terra", "sol"]),
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
  const agentId =
    requestedAgent &&
    requestedAgent !== "jarvis" &&
    TEAM_BY_SLUG[requestedAgent]
      ? requestedAgent
      : route.agentId === "jarvis"
        ? "atlas"
        : route.agentId;
  const approvalRequired =
    input.approvalRequired === true ||
    route.approvalRequired ||
    input.risk === "consequential";
  const risk = (approvalRequired
    ? "consequential"
    : input.risk && ["low", "medium", "high"].includes(input.risk)
      ? input.risk
      : route.risk) as WorkRisk;
  return {
    label: (
      input.label ||
      `${TEAM_BY_SLUG[agentId].name} · ${TEAM_BY_SLUG[agentId].role}`
    ).slice(0, 80),
    task: input.task.slice(0, 4000),
    agentId,
    repo: input.repo ?? null,
    model: route.model as ModelTier,
    readonly: input.readonly ?? route.readonly,
    approvalRequired,
    risk,
    acceptanceCriteria: input.acceptanceCriteria?.length
      ? input.acceptanceCriteria.slice(0, 8)
      : suggestedAcceptanceCriteria(input.task, route),
  };
}
