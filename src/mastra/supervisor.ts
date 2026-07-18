import "server-only";
import { z } from "zod";
import { PERMANENT_TEAM, TEAM_BY_SLUG, type AgentSlug, type ModelTier, type WorkRisk } from "./team";
import { routeWork, suggestedAcceptanceCriteria } from "./routing";

const workstreamSchema = z.object({
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

const missionSchema = z.object({
  mission: z.string().min(5).max(500),
  rationale: z.string().min(5).max(1000),
  workstreams: z.array(workstreamSchema).min(1).max(6),
});

export type ManagedWorkstream = z.infer<typeof workstreamSchema>;
export type ManagedMission = z.infer<typeof missionSchema> & { plannedBy: "mastra" | "deterministic" };

function deterministicPlan(goal: string, repo?: string): ManagedMission {
  const route = routeWork(goal, { repo });
  return {
    mission: goal.slice(0, 500),
    rationale: route.reason,
    workstreams: [
      {
        label: `${TEAM_BY_SLUG[route.agentId].name} · ${TEAM_BY_SLUG[route.agentId].role}`.slice(0, 80),
        task: goal.slice(0, 4000),
        agentId: route.agentId === "jarvis" ? "atlas" : route.agentId,
        repo: repo ?? null,
        model: route.model,
        readonly: route.readonly,
        approvalRequired: route.approvalRequired,
        risk: route.risk,
        acceptanceCriteria: suggestedAcceptanceCriteria(goal, route),
      },
    ],
    plannedBy: "deterministic",
  };
}

export async function planManagedMission(goal: string, options?: { repo?: string; context?: string }): Promise<ManagedMission> {
  // Mastra remains the typed orchestration contract; intelligence and work
  // execution are supplied by the subscription Codex supervisor/Trigger tasks.
  // This policy layer is intentionally deterministic and can never bill an API.
  void options?.context;
  return deterministicPlan(goal, options?.repo);
}

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
  const agentId = requestedAgent && requestedAgent !== "jarvis" && TEAM_BY_SLUG[requestedAgent] ? requestedAgent : route.agentId === "jarvis" ? "atlas" : route.agentId;
  const approvalRequired = input.approvalRequired === true || route.approvalRequired || input.risk === "consequential";
  const risk = (approvalRequired
    ? "consequential"
    : input.risk && ["low", "medium", "high"].includes(input.risk)
      ? input.risk
      : route.risk) as WorkRisk;
  return {
    label: (input.label || `${TEAM_BY_SLUG[agentId].name} · ${TEAM_BY_SLUG[agentId].role}`).slice(0, 80),
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
