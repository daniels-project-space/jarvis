import "server-only";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { TEAM_BY_SLUG } from "./team";
import { routeWork, suggestedAcceptanceCriteria } from "./routing";
import {
  normalizeWorkstream,
  workstreamSchema,
} from "./supervisor-routing";

export {
  normalizeWorkstream,
  type ManagedWorkstream,
} from "./supervisor-routing";

const missionSchema = z.object({
  mission: z.string().min(5).max(500),
  context: z.string().max(4000).nullable(),
  rationale: z.string().min(5).max(1000),
  workstreams: z.array(workstreamSchema).min(1).max(6),
});

export type ManagedMission = z.infer<typeof missionSchema> & { plannedBy: "mastra" | "deterministic" };

const candidateSchema = z.object({
  task: z.string().min(1).max(12_000),
  label: z.string().optional(),
  repo: z.string().optional(),
  model: z.string().optional(),
  agentId: z.string().optional(),
  readonly: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  risk: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
});

const missionInputSchema = z.object({
  goal: z.string().min(5).max(12_000),
  repo: z.string().max(500).optional(),
  context: z.string().max(12_000).optional(),
  workstreams: z.array(candidateSchema).max(6).optional(),
});

const routedMissionSchema = z.object({
  mission: z.string(),
  context: z.string().nullable(),
  rationale: z.string(),
  workstreams: z.array(workstreamSchema),
});

function deterministicPlan(goal: string, repo?: string, context?: string): ManagedMission {
  const route = routeWork(goal, { repo });
  return {
    mission: goal.slice(0, 500),
    context: context?.trim().slice(0, 4000) || null,
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

const routeMissionStep = createStep({
  id: "route-mission",
  description: "Route supplied or supervisor-authored workstreams to permanent specialists and Codex tiers.",
  inputSchema: missionInputSchema,
  outputSchema: routedMissionSchema,
  execute: async ({ inputData }) => {
    const supplied = inputData.workstreams?.filter((candidate) => candidate.task.trim()).slice(0, 6) ?? [];
    if (!supplied.length) {
      const plan = deterministicPlan(inputData.goal, inputData.repo, inputData.context);
      return {
        mission: plan.mission,
        context: plan.context,
        rationale: plan.rationale,
        workstreams: plan.workstreams,
      };
    }

    return {
      mission: inputData.goal.trim().slice(0, 500),
      context: inputData.context?.trim().slice(0, 4000) || null,
      rationale: "JARVIS supplied independent workstreams; Mastra routed each owner, risk boundary and Codex execution tier.",
      workstreams: supplied.map((candidate) =>
        normalizeWorkstream({
          ...candidate,
          repo: candidate.repo || inputData.repo,
        }),
      ),
    };
  },
});

const enforceMissionPolicyStep = createStep({
  id: "enforce-mission-policy",
  description: "Deduplicate workstreams, enforce approval gates and require evidence-based stopping conditions.",
  inputSchema: routedMissionSchema,
  outputSchema: missionSchema,
  execute: async ({ inputData }) => {
    const seen = new Set<string>();
    const workstreams = inputData.workstreams.filter((stream) => {
      const key = `${stream.agentId}:${stream.repo ?? ""}:${stream.task.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // The workflow cannot weaken a safety decision made by routing. A
    // consequential stream always waits for Daniel, even if a caller supplied
    // contradictory flags.
    const protectedWorkstreams = workstreams.map((stream) => {
      const route = routeWork(stream.task, {
        repo: stream.repo ?? undefined,
        requestedModel: stream.model,
        readonly: stream.readonly,
      });
      const approvalRequired = stream.approvalRequired || route.approvalRequired || stream.risk === "consequential";
      return {
        ...stream,
        model: route.model,
        readonly: approvalRequired ? true : stream.readonly,
        approvalRequired,
        risk: approvalRequired ? ("consequential" as const) : stream.risk,
        acceptanceCriteria: stream.acceptanceCriteria.length
          ? stream.acceptanceCriteria.slice(0, 8)
          : suggestedAcceptanceCriteria(stream.task, route),
      };
    });

    return missionSchema.parse({
      ...inputData,
      workstreams: protectedWorkstreams,
    });
  },
});

// This is a real Mastra graph, but deliberately has no model provider. The
// foreground subscription Codex session authors/decomposes work; Mastra owns
// typed routing and safety policy; isolated Codex CLI leases execute it.
export const managedMissionWorkflow = createWorkflow({
  id: "jarvis-managed-mission",
  inputSchema: missionInputSchema,
  outputSchema: missionSchema,
})
  .then(routeMissionStep)
  .then(enforceMissionPolicyStep)
  .commit();

export async function planManagedMission(
  goal: string,
  options?: {
    repo?: string;
    context?: string;
    workstreams?: z.infer<typeof candidateSchema>[];
  },
): Promise<ManagedMission> {
  try {
    const run = await managedMissionWorkflow.createRun();
    const result = await run.start({
      inputData: {
        goal,
        repo: options?.repo,
        context: options?.context,
        workstreams: options?.workstreams,
      },
    });
    if (result.status !== "success") throw new Error(`Mastra workflow ended with ${result.status}`);
    return { ...missionSchema.parse(result.result), plannedBy: "mastra" };
  } catch {
    // Planning must remain available if the workflow runtime itself is
    // unhealthy. This fallback uses the same non-billable policy router and
    // never invokes an API model.
    return deterministicPlan(goal, options?.repo, options?.context);
  }
}
