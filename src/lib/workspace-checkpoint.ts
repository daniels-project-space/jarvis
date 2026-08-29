export const WORKSPACE_CHECKPOINT_VERSION = 2 as const;

export type WorkspaceCheckpointProvider = "e2b" | "daytona" | "sandbox0" | "vercel" | "selfhost" | "cloudflare";

export type WorkspaceCheckpoint = {
  version: typeof WORKSPACE_CHECKPOINT_VERSION;
  jobId: string;
  attempt: number;
  provider: WorkspaceCheckpointProvider;
  providerWorkspaceId: string;
  providerSessionId: string;
  providerCheckpointId?: string;
  baseSha: string;
  sourceArchiveSha256: string;
  sourceArchiveBytes: number;
  archiveSha256: string;
  archiveBytes: number;
  runtime: string;
  lockfileDigest: string;
  template: string;
  attemptKey: string;
  causationId: string;
  createdAt: number;
};

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const PROVIDERS = new Set<WorkspaceCheckpointProvider>(["e2b", "daytona", "sandbox0", "vercel", "selfhost", "cloudflare"]);
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) {
    throw new Error(`checkpoint ${name} is invalid`);
  }
  return value;
}

function boundedBytes(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_ARCHIVE_BYTES) {
    throw new Error(`checkpoint ${name} is invalid`);
  }
  return Number(value);
}

export function normalizeWorkspaceCheckpoint(value: unknown): WorkspaceCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("checkpoint manifest is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== WORKSPACE_CHECKPOINT_VERSION) throw new Error("checkpoint version is invalid");
  const provider = boundedString(item.provider, "provider", 20) as WorkspaceCheckpointProvider;
  if (!PROVIDERS.has(provider)) throw new Error("checkpoint provider is invalid");
  const attempt = Number(item.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("checkpoint attempt is invalid");
  const createdAt = Number(item.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 1) throw new Error("checkpoint creation time is invalid");
  const baseSha = boundedString(item.baseSha, "base SHA", 64).toLowerCase();
  const sourceArchiveSha256 = boundedString(item.sourceArchiveSha256, "source digest", 64).toLowerCase();
  const archiveSha256 = boundedString(item.archiveSha256, "archive digest", 64).toLowerCase();
  const lockfileDigest = boundedString(item.lockfileDigest, "lockfile digest", 64).toLowerCase();
  if (!GIT_OID.test(baseSha) || !SHA256.test(sourceArchiveSha256) || !SHA256.test(archiveSha256) || !SHA256.test(lockfileDigest)) {
    throw new Error("checkpoint digest binding is invalid");
  }
  const providerWorkspaceId = boundedString(item.providerWorkspaceId, "workspace identity", 240);
  const providerSessionId = boundedString(item.providerSessionId, "session identity", 240);
  if (providerWorkspaceId === providerSessionId) throw new Error("checkpoint workspace and session identities must differ");
  const providerCheckpointId = item.providerCheckpointId === undefined
    ? undefined
    : boundedString(item.providerCheckpointId, "provider checkpoint identity", 240);
  return {
    version: WORKSPACE_CHECKPOINT_VERSION,
    jobId: boundedString(item.jobId, "job identity", 160),
    attempt,
    provider,
    providerWorkspaceId,
    providerSessionId,
    ...(providerCheckpointId ? { providerCheckpointId } : {}),
    baseSha,
    sourceArchiveSha256,
    sourceArchiveBytes: boundedBytes(item.sourceArchiveBytes, "source byte count"),
    archiveSha256,
    archiveBytes: boundedBytes(item.archiveBytes, "archive byte count"),
    runtime: boundedString(item.runtime, "runtime", 120),
    lockfileDigest,
    template: boundedString(item.template, "template", 240),
    attemptKey: boundedString(item.attemptKey, "attempt key", 320),
    causationId: boundedString(item.causationId, "causation", 320),
    createdAt,
  };
}

export function canonicalWorkspaceCheckpoint(value: WorkspaceCheckpoint): string {
  const item = normalizeWorkspaceCheckpoint(value);
  return JSON.stringify({
    version: item.version,
    jobId: item.jobId,
    attempt: item.attempt,
    provider: item.provider,
    providerWorkspaceId: item.providerWorkspaceId,
    providerSessionId: item.providerSessionId,
    ...(item.providerCheckpointId ? { providerCheckpointId: item.providerCheckpointId } : {}),
    baseSha: item.baseSha,
    sourceArchiveSha256: item.sourceArchiveSha256,
    sourceArchiveBytes: item.sourceArchiveBytes,
    archiveSha256: item.archiveSha256,
    archiveBytes: item.archiveBytes,
    runtime: item.runtime,
    lockfileDigest: item.lockfileDigest,
    template: item.template,
    attemptKey: item.attemptKey,
    causationId: item.causationId,
    createdAt: item.createdAt,
  });
}

export function parseCanonicalWorkspaceCheckpoint(value: string): WorkspaceCheckpoint {
  if (!value || value.length > 4_000) throw new Error("checkpoint manifest is missing or oversized");
  const parsed = normalizeWorkspaceCheckpoint(JSON.parse(value));
  if (canonicalWorkspaceCheckpoint(parsed) !== value) throw new Error("checkpoint manifest is not canonical");
  return parsed;
}
