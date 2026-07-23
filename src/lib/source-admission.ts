import { PROJECT_BY_REPOSITORY } from "./project-registry";
import { canonicalizeRepository } from "./workflow-contract";

export const SOURCE_ADMISSION_PROTOCOL_VERSION = 2 as const;
export const EVIDENCE_PROJECT_ID = "evidence";
export const SOURCE_ADMISSION_FRESH_MS = 10 * 60_000;

const GITHUB_OID = /^[0-9a-f]{40}$/i;

export type ProjectSourceAdmission = Readonly<{
  protocolVersion: typeof SOURCE_ADMISSION_PROTOCOL_VERSION;
  canonicalProjectId: string;
  repository?: string;
  sourceProvider: "github" | "none";
  sourceBranch?: string;
  sourceRef?: string;
  sourceHeadSha?: string;
  sourceObservedAt: number;
  sourceAdmissionDigest: string;
}>;

export type ProjectSourceAdmissionCore = Omit<ProjectSourceAdmission, "sourceAdmissionDigest">;

export function canonicalProjectIdForRepository(value: unknown): string | null {
  const repository = canonicalizeRepository(value, { allowShortName: true });
  if (!repository) return null;
  return PROJECT_BY_REPOSITORY.get(repository)?.slug ?? null;
}

export function isAllowedProjectRepository(value: unknown): boolean {
  return canonicalProjectIdForRepository(value) !== null;
}

/** Conservative equivalent of `git check-ref-format --branch` for persisted source authority. */
export function isSafeSourceBranch(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 240) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{") || /[\u0000-\u0020\u007f~^:?*\\[\\]\\\\]/.test(value)) return false;
  return value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export function canonicalProjectSourceAdmission(value: ProjectSourceAdmissionCore): string {
  return JSON.stringify({
    protocolVersion: value.protocolVersion,
    canonicalProjectId: value.canonicalProjectId,
    repository: value.repository ?? null,
    sourceProvider: value.sourceProvider,
    sourceBranch: value.sourceBranch ?? null,
    sourceRef: value.sourceRef ?? null,
    sourceHeadSha: value.sourceHeadSha ?? null,
    sourceObservedAt: value.sourceObservedAt,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealProjectSourceAdmission(core: ProjectSourceAdmissionCore): Promise<ProjectSourceAdmission> {
  return {
    ...core,
    sourceAdmissionDigest: await sha256Hex(canonicalProjectSourceAdmission(core)),
  };
}

export async function evidenceProjectSourceAdmission(now = Date.now()): Promise<ProjectSourceAdmission> {
  return await sealProjectSourceAdmission({
    protocolVersion: SOURCE_ADMISSION_PROTOCOL_VERSION,
    canonicalProjectId: EVIDENCE_PROJECT_ID,
    sourceProvider: "none",
    sourceObservedAt: now,
  });
}

export async function projectSourceAdmissionIsValid(
  value: unknown,
  options: { expectedRepository?: string; now?: number; requireFresh?: boolean } = {},
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const admission = value as ProjectSourceAdmission;
  if (admission.protocolVersion !== SOURCE_ADMISSION_PROTOCOL_VERSION
    || !Number.isSafeInteger(admission.sourceObservedAt) || admission.sourceObservedAt <= 0
    || !/^[0-9a-f]{64}$/.test(String(admission.sourceAdmissionDigest ?? ""))) return false;
  const now = options.now ?? Date.now();
  if (admission.sourceObservedAt > now + 60_000) return false;
  if (options.requireFresh && now - admission.sourceObservedAt > SOURCE_ADMISSION_FRESH_MS) return false;

  const expectedRepository = options.expectedRepository === undefined
    ? undefined
    : canonicalizeRepository(options.expectedRepository, { allowShortName: true }) ?? "";
  if (expectedRepository === "") return false;
  if (!admission.repository) {
    if (expectedRepository !== undefined || admission.canonicalProjectId !== EVIDENCE_PROJECT_ID
      || admission.sourceProvider !== "none" || admission.sourceBranch !== undefined
      || admission.sourceRef !== undefined || admission.sourceHeadSha !== undefined) return false;
  } else {
    const repository = canonicalizeRepository(admission.repository, { allowShortName: false });
    const canonicalProjectId = canonicalProjectIdForRepository(repository);
    if (!repository || repository !== admission.repository || repository !== expectedRepository
      || !canonicalProjectId || canonicalProjectId !== admission.canonicalProjectId
      || admission.sourceProvider !== "github" || !isSafeSourceBranch(admission.sourceBranch)
      || admission.sourceRef !== `refs/heads/${admission.sourceBranch}`
      || !GITHUB_OID.test(String(admission.sourceHeadSha ?? ""))) return false;
  }
  const { sourceAdmissionDigest: _digest, ...core } = admission;
  return admission.sourceAdmissionDigest === await sha256Hex(canonicalProjectSourceAdmission(core));
}

type GitHubRepositoryResponse = { full_name?: unknown; default_branch?: unknown };
type GitHubRefResponse = { ref?: unknown; object?: { type?: unknown; sha?: unknown } };

export async function observeGitHubProjectSource(args: {
  repository: string;
  requestedBranch?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ProjectSourceAdmission> {
  const repository = canonicalizeRepository(args.repository, { allowShortName: true });
  const canonicalProjectId = canonicalProjectIdForRepository(repository);
  if (!repository || !canonicalProjectId) throw new Error("Repository is not in the canonical JARVIS project allowlist");
  if (args.requestedBranch !== undefined && !isSafeSourceBranch(args.requestedBranch)) {
    throw new Error("Explicit source branch is invalid");
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (args.token) headers.authorization = `Bearer ${args.token}`;
  const root = `https://api.github.com/repos/${repository}`;
  const metadataResponse = await fetchImpl(root, { headers, cache: "no-store" });
  if (!metadataResponse.ok) throw new Error(`GitHub repository observation failed (${metadataResponse.status})`);
  const metadata = await metadataResponse.json() as GitHubRepositoryResponse;
  if (String(metadata.full_name ?? "").toLowerCase() !== repository) throw new Error("GitHub repository identity mismatch");
  const sourceBranch = args.requestedBranch ?? String(metadata.default_branch ?? "");
  if (!isSafeSourceBranch(sourceBranch)) throw new Error("GitHub did not return a safe explicit source branch");
  const sourceRef = `refs/heads/${sourceBranch}`;
  const refResponse = await fetchImpl(`${root}/git/ref/heads/${encodeURIComponent(sourceBranch)}`, {
    headers,
    cache: "no-store",
  });
  if (!refResponse.ok) throw new Error(`GitHub source-ref observation failed (${refResponse.status})`);
  const observed = await refResponse.json() as GitHubRefResponse;
  const sourceHeadSha = String(observed.object?.sha ?? "").toLowerCase();
  if (observed.ref !== sourceRef || observed.object?.type !== "commit" || !GITHUB_OID.test(sourceHeadSha)) {
    throw new Error("GitHub source ref did not prove an exact commit identity");
  }
  return await sealProjectSourceAdmission({
    protocolVersion: SOURCE_ADMISSION_PROTOCOL_VERSION,
    canonicalProjectId,
    repository,
    sourceProvider: "github",
    sourceBranch,
    sourceRef,
    sourceHeadSha,
    sourceObservedAt: args.now ?? Date.now(),
  });
}
