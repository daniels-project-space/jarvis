import teamManifest from "../../agents/jarvis-team.manifest.json";

export const WORKFLOW_CONTRACT_VERSION = "1.0";

export type TeamManifestAgent = {
  slug: "jarvis" | "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  defaultModel: "luna" | "terra" | "sol";
  autonomy: "supervised" | "read-only" | "verified-auto-delivery" | "draft-only" | "safe-auto-fix";
  instructions: string;
};

type TeamManifest = {
  schemaVersion: string;
  kind: string;
  scope: {
    githubHost: string;
    githubProtocol: string;
    owner: string;
    credentialPolicy: string;
    sharedWritableState: string;
  };
  agents: TeamManifestAgent[];
};

export const SCOPED_TEAM_MANIFEST = teamManifest as TeamManifest;

/**
 * The repository-owned durable-work contract. It is intentionally data-only:
 * no provider IDs, access tokens, or deployment values can enter this layer.
 */
export const WORKFLOW_CONTRACT = Object.freeze({
  version: WORKFLOW_CONTRACT_VERSION,
  teamManifestKind: SCOPED_TEAM_MANIFEST.kind,
  scope: Object.freeze({ ...SCOPED_TEAM_MANIFEST.scope }),
  durableRuntime: "trigger.dev",
  controlPlane: "convex",
  behaviorRouter: "mastra",
  artifactStore: "cloudflare-r2",
  intelligenceRuntime: "codex-cli-subscription",
  credentialBoundary: SCOPED_TEAM_MANIFEST.scope.credentialPolicy,
  sharedWritableState: SCOPED_TEAM_MANIFEST.scope.sharedWritableState,
});

export type RepositoryNormalizationOptions = {
  allowShortName?: boolean;
};

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const REPOSITORY_PATTERN = /^[a-z\d](?:[a-z\d._-]{0,98}[a-z\d])?$/i;

/** Known product aliases are inputs only; persistence always uses owner/repo. */
export const REPOSITORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "project-hub": "daniels-project-space/project-hub",
  "project-hub-app": "daniels-project-space/project-hub",
  hub: "daniels-project-space/project-hub",
  "remote-work-hub": "daniels-project-space/remote-work-hub",
  "media-engine": "daniels-project-space/media-engine",
  "app-factory-v2": "daniels-project-space/app-factory-v2",
  "db-cinema-v2": "daniels-project-space/db-cinema-v2",
  "rental-manager-v2": "daniels-project-space/rental-manager-v2",
  rmv2: "daniels-project-space/rental-manager-v2",
  "music-house": "daniels-project-space/music-house",
  "youtube-studio-ai": "daniels-project-space/youtube-studio-ai",
  "finance-engine-v2": "daniels-project-space/finance-engine-v2",
  "dropship-ai": "daniels-project-space/dropship-ai",
  jarvis: "daniels-project-space/jarvis",
  "jarvis-memory": "daniels-project-space/jarvis-memory",
});

function partsToCanonical(owner: string, repository: string): string | null {
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepository = repository.toLowerCase();
  if (!OWNER_PATTERN.test(normalizedOwner) || !REPOSITORY_PATTERN.test(normalizedRepository)) return null;
  return `${normalizedOwner}/${normalizedRepository}`;
}

/**
 * Converts a GitHub owner/repo slug or an exact public HTTPS GitHub remote to
 * one persisted identity. Credentials, alternate transports, URL decorations,
 * ambiguous paths, encoded separators, and traversal all fail closed.
 */
export function canonicalizeRepository(value: unknown, options: RepositoryNormalizationOptions = {}): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || /[\\\u0000-\u001f\u007f]/.test(raw) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(raw)) return null;
  if (/%2f|%5c|%2e/i.test(raw)) return null;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== WORKFLOW_CONTRACT.scope.githubHost ||
      url.port || url.username || url.password || url.search || url.hash
    ) return null;
    const segments = url.pathname.split("/");
    if (segments.length !== 3 || segments[0] !== "" || !segments[1] || !segments[2]) return null;
    const repository = segments[2].replace(/\.git$/i, "");
    if (!repository || /\.git$/i.test(repository)) return null;
    return partsToCanonical(segments[1], repository);
  }

  if (/[@?:#]/.test(raw) || raw.includes("//")) return null;
  const segments = raw.split("/");
  if (segments.length === 1 && options.allowShortName) {
    const alias = REPOSITORY_ALIASES[segments[0].toLowerCase()];
    return alias ?? partsToCanonical(WORKFLOW_CONTRACT.scope.owner, segments[0]);
  }
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const repository = segments[1].replace(/\.git$/i, "");
  if (!repository || /\.git$/i.test(repository)) return null;
  return partsToCanonical(segments[0], repository);
}

export function requireCanonicalRepository(value: unknown, options?: RepositoryNormalizationOptions): string {
  const canonical = canonicalizeRepository(value, options);
  if (!canonical) {
    throw new Error("Repository must be an owner/repo slug or credential-free https://github.com/owner/repo(.git) URL");
  }
  return canonical;
}

export function isOwnedRepositoryScope(value: unknown): boolean {
  const canonical = canonicalizeRepository(value, { allowShortName: true });
  return Boolean(canonical?.startsWith(`${WORKFLOW_CONTRACT.scope.owner}/`));
}

export function githubRepositoryUrl(value: unknown): string {
  return `https://${WORKFLOW_CONTRACT.scope.githubHost}/${requireCanonicalRepository(value)}.git`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The canonical renderer makes committed project agents mechanically auditable. */
export function renderCodexAgentToml(agent: TeamManifestAgent): string {
  return [
    "# Generated from agents/jarvis-team.manifest.json. Do not edit by hand.",
    `name = ${tomlString(agent.slug)}`,
    `description = ${tomlString(agent.description)}`,
    `developer_instructions = ${tomlString(agent.instructions)}`,
    "",
  ].join("\n");
}
