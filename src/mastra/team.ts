import type { WorkModelTier } from "../lib/work-models";
import { SCOPED_TEAM_MANIFEST, type TeamManifestAgent } from "../lib/workflow-contract";

export type AgentSlug = "jarvis" | "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";
export type ModelTier = WorkModelTier;
export type WorkRisk = "low" | "medium" | "high" | "consequential";

export type PermanentAgent = TeamManifestAgent & {
  slug: AgentSlug;
  defaultModel: ModelTier;
};

/** Mastra's routing identity is the same versioned manifest the runner enforces. */
export const PERMANENT_TEAM: readonly PermanentAgent[] = SCOPED_TEAM_MANIFEST.agents as PermanentAgent[];

export const TEAM_BY_SLUG = Object.fromEntries(PERMANENT_TEAM.map((agent) => [agent.slug, agent])) as Record<
  AgentSlug,
  PermanentAgent
>;
