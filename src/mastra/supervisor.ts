import "server-only";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { PERMANENT_TEAM, TEAM_BY_SLUG, type AgentSlug, type ModelTier, type WorkRisk } from "./team";
import { routeWork, suggestedAcceptanceCriteria } from "./routing";

const model = "openai/gpt-5.6";

function specialist(slug: Exclude<AgentSlug, "jarvis">) {
  const profile = TEAM_BY_SLUG[slug];
  return new Agent({
    id: profile.slug,
    name: profile.name,
    description: `${profile.role}. ${profile.description}`,
    instructions: profile.instructions,
    model,
    maxRetries: 2,
  });
}

export const permanentAgents = {
  paul: specialist("paul"),
  atlas: specialist("atlas"),
  iris: specialist("iris"),
  maya: specialist("maya"),
  sentry: specialist("sentry"),
};

export const jarvisSupervisor = new Agent({
  id: "jarvis",
  name: "JARVIS",
  description: TEAM_BY_SLUG.jarvis.description,
  instructions:
    TEAM_BY_SLUG.jarvis.instructions +
    " You are the manager control plane, while Trigger.dev is the durable execution plane. Produce a lean plan of independent workstreams for the permanent team. Do not pretend a delegate has executed work during planning. Mark consequential external actions for approval. Prefer one strong owner when parallelism would add coordination cost.",
  model,
  agents: permanentAgents,
  maxRetries: 2,
  defaultOptions: {
    maxSteps: 6,
    toolCallConcurrency: 3,
  },
});

const workstreamSchema = z.object({
  label: z.string().min(3).max(80),
  task: z.string().min(12).max(4000),
  agentId: z.enum(["paul", "atlas", "iris", "maya", "sentry"]),
  repo: z.string().nullable(),
  model: z.enum(["haiku", "sonnet", "opus"]),
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
  // The conversational Codex subscription worker normally supplies explicit
  // workstreams. Keep Mastra's deterministic policy fallback available here,
  // but never silently bill a metered model merely because Vercel has an API
  // key for Realtime/vision surfaces.
  if (process.env.JARVIS_ALLOW_METERED_MASTRA !== "1" || !process.env.OPENAI_API_KEY) {
    return deterministicPlan(goal, options?.repo);
  }
  try {
    const roster = PERMANENT_TEAM.filter((agent) => agent.slug !== "jarvis")
      .map((agent) => `- ${agent.slug}: ${agent.role} — ${agent.description}`)
      .join("\n");
    const result = await jarvisSupervisor.generate(
      `Plan durable work for this goal:\n${goal}\n\nRepository if known: ${options?.repo ?? "none"}\n` +
        `Conversation/project context:\n${options?.context?.slice(0, 5000) ?? "none supplied"}\n\nPermanent team:\n${roster}\n\n` +
        "Use parallel workstreams only when independent. Each task starts blank, so include all necessary context. Code work goes to Paul on an isolated branch. Research is read-only. Publishing, messaging, booking, money, destructive actions and production deployment require approval.",
      {
        maxSteps: 6,
        structuredOutput: { schema: missionSchema },
        delegation: {
          onDelegationStart: ({ prompt }) => ({ modifiedPrompt: `${prompt}\nReturn planning advice only; do not claim execution.` }),
        },
      },
    );
    const parsed = missionSchema.parse(result.object);
    return { ...parsed, plannedBy: "mastra" };
  } catch {
    return deterministicPlan(goal, options?.repo);
  }
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
