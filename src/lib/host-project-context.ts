import type { JarvisHostContext } from "./host-context";
import { PROJECT_REGISTRY, type ProjectProfile } from "./project-registry";

export type ResolvedHostProjectContext = {
  project: ProjectProfile;
  context: JarvisHostContext;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normal(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Converts browser-supplied page context into a repository scope only when the
 * app identity and current origin both match a registered production project.
 * The rest of the host context remains untrusted evidence for the worker.
 */
export function resolveHostProjectContext(value: unknown): ResolvedHostProjectContext | null {
  const raw = record(value);
  if (!raw || typeof raw.app !== "string" || typeof raw.url !== "string") return null;

  const app = normal(raw.app);
  if (!app) return null;

  let hostOrigin: string;
  try {
    hostOrigin = new URL(raw.url).origin;
  } catch {
    return null;
  }

  const project = PROJECT_REGISTRY.find((candidate) => (
    normal(candidate.slug) === app || normal(candidate.name) === app
  ));
  if (!project?.productionUrl) return null;

  try {
    if (new URL(project.productionUrl).origin !== hostOrigin) return null;
  } catch {
    return null;
  }

  return { project, context: raw as JarvisHostContext };
}
