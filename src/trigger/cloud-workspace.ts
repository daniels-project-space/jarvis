import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  canonicalWorkspaceCheckpoint,
  normalizeWorkspaceCheckpoint,
  parseCanonicalWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from "../lib/workspace-checkpoint";

export type { WorkspaceCheckpoint } from "../lib/workspace-checkpoint";

export type CloudWorkspaceProviderName = "e2b" | "daytona" | "sandbox0" | "cloudflare";
export type CloudWorkspaceFailureCode =
  | "missing_configuration"
  | "invalid_configuration"
  | "provider_probe_attestation_failed"
  | "controller_isolation_unproven"
  | "capability_unsupported"
  | "provider_unavailable"
  | "stale_attempt"
  | "cancelled"
  | "timeout"
  | "resource_limit"
  | "unsafe_archive"
  | "unsafe_patch"
  | "digest_mismatch"
  | "checkpoint_missing"
  | "checkpoint_incompatible"
  | "checkpoint_tampered"
  | "cleanup_blocked";

export class CloudWorkspaceError extends Error {
  constructor(
    readonly provider: CloudWorkspaceProviderName,
    readonly code: CloudWorkspaceFailureCode,
    message: string,
    readonly disposition: "blocked" | "deferred" | "rejected" = "blocked",
  ) {
    super(message);
    this.name = "CloudWorkspaceError";
  }
}

export type CloudWorkspaceCapabilities = {
  credentiallessArchive: boolean;
  privateIngress: boolean;
  networkDenyByDefault: boolean;
  emptyEnvironment: boolean;
  boundedResources: boolean;
  boundedTtl: boolean;
  exactCommandCancellation: boolean;
  sameWorkspaceResume: boolean;
  portableCheckpointReplay: boolean;
  providerSnapshots: boolean;
  persistentVolumes: boolean;
  opaqueSecretProjection: boolean;
};

export type WorkspaceLimits = {
  ttlMs: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxArchiveBytes: number;
  cpu: number;
  memoryMb: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  ttlMs: 55 * 60_000,
  commandTimeoutMs: 15 * 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
  cpu: 2,
  memoryMb: 4 * 1024,
};

export type CloudWorkspace = {
  provider: CloudWorkspaceProviderName;
  providerWorkspaceId: string;
  providerSessionId: string;
  root: string;
  createdAt: number;
};

export type CredentiallessArchive = {
  baseSha: string;
  sha256: string;
  bytes: Uint8Array;
};

export type PatchManifest = {
  baseSha: string;
  sha256: string;
  byteCount: number;
  patch: Uint8Array;
};

export type ExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  providerSessionId: string;
  durationMs: number;
};

export interface CloudWorkspaceProvider {
  readonly name: CloudWorkspaceProviderName;
  readonly capabilities: CloudWorkspaceCapabilities;
  createWorkspace(input: {
    attemptKey: string;
    template: string;
    runtime: string;
    lockfileDigest: string;
    limits: WorkspaceLimits;
  }): Promise<CloudWorkspace>;
  uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void>;
  exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult>;
  readFile(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array>;
  writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void>;
  listFiles(workspace: CloudWorkspace, path: string, maxEntries: number): Promise<string[]>;
  checkpoint(workspace: CloudWorkspace, input: {
    jobId: string;
    attempt: number;
    baseSha: string;
    sourceArchiveSha256: string;
    sourceArchiveBytes: number;
    runtime: string;
    lockfileDigest: string;
    template: string;
    attemptKey: string;
    causationId: string;
  }): Promise<{ manifest: WorkspaceCheckpoint; archive: Uint8Array }>;
  recreateFromCheckpoint(input: {
    checkpoint: WorkspaceCheckpoint;
    archive: Uint8Array;
    limits: WorkspaceLimits;
    attemptKey: string;
  }): Promise<CloudWorkspace>;
  exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number): Promise<PatchManifest>;
  terminate(workspace: CloudWorkspace, reason: "terminal" | "orphan" | "cancelled"): Promise<void>;
}

export const sha256Bytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export function assertWorkspaceIdentity(workspace: CloudWorkspace): void {
  if (!workspace.providerWorkspaceId || !workspace.providerSessionId) {
    throw new CloudWorkspaceError(workspace.provider, "invalid_configuration", "provider workspace and session ids are required");
  }
  if (workspace.providerWorkspaceId === workspace.providerSessionId) {
    throw new CloudWorkspaceError(workspace.provider, "invalid_configuration", "provider workspace and session ids must be separate identities");
  }
}

export const REQUIRED_CLOUD_WORKSPACE_CAPABILITIES = Object.freeze([
    "credentiallessArchive",
    "privateIngress",
    "networkDenyByDefault",
    "emptyEnvironment",
    "boundedResources",
    "boundedTtl",
    "exactCommandCancellation",
    "portableCheckpointReplay",
] as const satisfies readonly (keyof CloudWorkspaceCapabilities)[]);

export function assertRequiredCapabilities(provider: CloudWorkspaceProvider): void {
  const missing = REQUIRED_CLOUD_WORKSPACE_CAPABILITIES.filter((capability) => !provider.capabilities[capability]);
  if (missing.length) {
    throw new CloudWorkspaceError(
      provider.name,
      "capability_unsupported",
      `${provider.name} cannot satisfy required cloud workspace capabilities: ${missing.join(", ")}`,
    );
  }
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

export function validateRelativePath(value: string, provider: CloudWorkspaceProviderName = "cloudflare"): string {
  const path = value.replace(/\\/g, "/");
  if (!path || path.includes("\0") || path.startsWith("/") || WINDOWS_ABSOLUTE.test(value)) {
    throw new CloudWorkspaceError(provider, "unsafe_archive", `unsafe absolute or empty path: ${value}`, "rejected");
  }
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || path.split("/").includes("..")) {
    throw new CloudWorkspaceError(provider, "unsafe_archive", `unsafe traversal path: ${value}`, "rejected");
  }
  return normalized.replace(/^\.\//, "");
}

function tarString(bytes: Uint8Array, start: number, length: number): string {
  const raw = bytes.subarray(start, start + length);
  const zero = raw.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(zero < 0 ? raw : raw.subarray(0, zero));
}

function tarOctal(bytes: Uint8Array, start: number, length: number): number {
  const text = tarString(bytes, start, length).replace(/\0/g, "").trim();
  if (!/^[0-7]*$/.test(text)) return Number.NaN;
  return text ? Number.parseInt(text, 8) : 0;
}

function verifyTarChecksum(bytes: Uint8Array, offset: number): boolean {
  let expected;
  try { expected = tarOctal(bytes, offset + 148, 8); }
  catch { return false; }
  if (!Number.isFinite(expected)) return false;
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : bytes[offset + index];
  }
  return sum === expected;
}

export type ValidatedTarMember = { path: string; type: "0" | "5" | "g"; size: number; data: Uint8Array };

function validateGlobalPax(data: Uint8Array, provider: CloudWorkspaceProviderName): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (!text) throw new CloudWorkspaceError(provider, "unsafe_archive", "archive has empty pax metadata", "rejected");
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 1) throw new CloudWorkspaceError(provider, "unsafe_archive", "archive has malformed pax metadata", "rejected");
    const lengthText = text.slice(offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new CloudWorkspaceError(provider, "unsafe_archive", "archive has malformed pax length", "rejected");
    const length = Number(lengthText);
    const record = text.slice(space + 1, offset + length);
    if (!Number.isSafeInteger(length) || offset + length > text.length || !record.endsWith("\n")) {
      throw new CloudWorkspaceError(provider, "unsafe_archive", "archive has truncated pax metadata", "rejected");
    }
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1, -1);
    if (equals < 1 || key !== "comment" || !/^[0-9a-f]{40,64}$/i.test(value)) {
      throw new CloudWorkspaceError(provider, "unsafe_archive", `archive contains an unvalidated pax override: ${key || "unknown"}`, "rejected");
    }
    offset += length;
  }
}

export function validatedTarMembers(
  bytes: Uint8Array,
  limits: Pick<WorkspaceLimits, "maxArchiveBytes" | "maxFileBytes"> = DEFAULT_WORKSPACE_LIMITS,
  provider: CloudWorkspaceProviderName = "cloudflare",
): ValidatedTarMember[] {
  if (!bytes.byteLength || bytes.byteLength > limits.maxArchiveBytes) {
    throw new CloudWorkspaceError(provider, "resource_limit", "archive byte count is empty or exceeds the configured limit", "rejected");
  }
  let offset = 0;
  let zeroBlocks = 0;
  let expandedBytes = 0;
  const members: ValidatedTarMember[] = [];
  const paths = new Set<string>();
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks) throw new CloudWorkspaceError(provider, "unsafe_archive", "archive has data after its end marker", "rejected");
    if (!verifyTarChecksum(bytes, offset)) {
      throw new CloudWorkspaceError(provider, "unsafe_archive", "archive contains an invalid tar checksum", "rejected");
    }
    let name: string;
    let prefix: string;
    try {
      name = tarString(bytes, offset, 100);
      prefix = tarString(bytes, offset + 345, 155);
    } catch {
      throw new CloudWorkspaceError(provider, "unsafe_archive", "archive path is not valid UTF-8", "rejected");
    }
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const path = validateRelativePath(rawPath, provider);
    if (path !== rawPath.replace(/^\.\//, "") || paths.has(path)) {
      throw new CloudWorkspaceError(provider, "unsafe_archive", `archive contains a non-canonical or duplicate path: ${rawPath}`, "rejected");
    }
    const rawType = String.fromCharCode(bytes[offset + 156] || 48);
    const type = rawType === "\0" ? "0" : rawType;
    let size;
    try { size = tarOctal(bytes, offset + 124, 12); }
    catch { throw new CloudWorkspaceError(provider, "unsafe_archive", "archive member size is malformed", "rejected"); }
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
      throw new CloudWorkspaceError(provider, "resource_limit", "archive member exceeds the configured byte limit", "rejected");
    }
    if (type !== "0" && type !== "5" && type !== "g") {
      const kind = ({
        "1": "hardlink", "2": "symlink", "3": "device", "4": "device", "6": "device",
        "x": "pax path override", "L": "GNU long-path override", "K": "GNU long-link override",
      } as Record<string, string>)[type] ?? "unsupported";
      throw new CloudWorkspaceError(provider, "unsafe_archive", `archive contains a ${kind} member`, "rejected");
    }
    if (type === "5" && size !== 0) throw new CloudWorkspaceError(provider, "unsafe_archive", "archive directory has a payload", "rejected");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) {
      throw new CloudWorkspaceError(provider, "unsafe_archive", "archive member is truncated", "rejected");
    }
    if (type === "g") validateGlobalPax(bytes.subarray(dataStart, dataEnd), provider);
    expandedBytes += size;
    if (expandedBytes > limits.maxArchiveBytes) {
      throw new CloudWorkspaceError(provider, "resource_limit", "archive expanded content exceeds the configured limit", "rejected");
    }
    paths.add(path);
    members.push({ path, type, size, data: bytes.subarray(dataStart, dataEnd) });
    if (members.length > 10_000) throw new CloudWorkspaceError(provider, "resource_limit", "archive contains too many members", "rejected");
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || !members.length || bytes.subarray(offset).some((byte) => byte !== 0)) {
    throw new CloudWorkspaceError(provider, "unsafe_archive", "archive is empty, unterminated, or has trailing data", "rejected");
  }
  return members;
}

export function validateCredentiallessArchive(
  archive: CredentiallessArchive,
  limits: Pick<WorkspaceLimits, "maxArchiveBytes" | "maxFileBytes"> = DEFAULT_WORKSPACE_LIMITS,
  provider: CloudWorkspaceProviderName = "cloudflare",
): void {
  if (!/^[0-9a-f]{40,64}$/i.test(archive.baseSha)) {
    throw new CloudWorkspaceError(provider, "unsafe_archive", "archive base SHA is invalid", "rejected");
  }
  if (sha256Bytes(archive.bytes) !== archive.sha256) {
    throw new CloudWorkspaceError(provider, "digest_mismatch", "archive digest does not match its bytes", "rejected");
  }
  validatedTarMembers(archive.bytes, limits, provider);
}

const SECRET_LIKE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,})/i;

export function validateSandboxOutput(
  value: string,
  maxBytes: number,
  provider: CloudWorkspaceProviderName = "cloudflare",
): string {
  if (Buffer.byteLength(value) > maxBytes) {
    throw new CloudWorkspaceError(provider, "resource_limit", "sandbox output exceeds its byte limit", "rejected");
  }
  if (value.includes("\0")) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "binary sandbox output is not accepted", "rejected");
  }
  if (SECRET_LIKE.test(value)) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "secret-like material detected in sandbox output", "rejected");
  }
  return value;
}

function patchPath(raw: string, provider: CloudWorkspaceProviderName): string {
  if (raw === "/dev/null") return raw;
  if (raw.startsWith("\"") || /\s/.test(raw)) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "quoted or whitespace-bearing patch paths are not accepted", "rejected");
  }
  const stripped = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return validateRelativePath(stripped, provider);
}

export function validatePatchManifest(
  manifest: PatchManifest,
  expectedBaseSha: string,
  maxBytes = DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes,
  provider: CloudWorkspaceProviderName = "cloudflare",
): void {
  if (manifest.baseSha !== expectedBaseSha) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "patch base SHA changed during execution", "rejected");
  }
  if (manifest.byteCount !== manifest.patch.byteLength || manifest.byteCount > maxBytes) {
    throw new CloudWorkspaceError(provider, "resource_limit", "patch byte count is invalid or oversized", "rejected");
  }
  if (sha256Bytes(manifest.patch) !== manifest.sha256) {
    throw new CloudWorkspaceError(provider, "digest_mismatch", "patch digest does not match its bytes", "rejected");
  }
  if (manifest.patch.includes(0)) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "binary patch output is not accepted", "rejected");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(manifest.patch);
  if (/GIT binary patch|^Binary files /m.test(text)) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "binary patch output is not accepted", "rejected");
  }
  if (SECRET_LIKE.test(text)) {
    throw new CloudWorkspaceError(provider, "unsafe_patch", "secret-like material detected in patch output", "rejected");
  }
  for (const match of text.matchAll(/^(?:old|new|new file|deleted file) mode\s+([0-7]+)$/gm)) {
    if (!/^(?:100644|100755)$/.test(match[1])) {
      throw new CloudWorkspaceError(
        provider,
        "unsafe_patch",
        `non-regular patch mode is not accepted: ${match[1]}`,
        "rejected",
      );
    }
  }
  for (const match of text.matchAll(/^(?:---|\+\+\+)\s+([^\t\r\n]+)/gm)) patchPath(match[1], provider);
  for (const match of text.matchAll(/^diff --git\s+(\S+)\s+(\S+)$/gm)) {
    patchPath(match[1], provider);
    patchPath(match[2], provider);
  }
  for (const match of text.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm)) patchPath(match[1], provider);
}

function writeTarOctal(header: Uint8Array, start: number, length: number, value: number): void {
  const encoded = new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0");
  header.set(encoded, start);
}

export function createDeterministicTar(entries: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = validateRelativePath(entry.path);
    const pathBytes = encoder.encode(path);
    if (pathBytes.byteLength > 100) throw new CloudWorkspaceError("cloudflare", "unsafe_archive", "deterministic tar path is too long", "rejected");
    const header = new Uint8Array(512);
    header.set(pathBytes, 0);
    header.set(encoder.encode("0000644\0"), 100);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.data.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header, entry.data, new Uint8Array((512 - entry.data.byteLength % 512) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(blocks.map((block) => Buffer.from(block))));
}

export function createPortableCheckpointArchive(source: CredentiallessArchive, patch: Uint8Array): Uint8Array {
  validateCredentiallessArchive(source);
  validatePatchManifest({ baseSha: source.baseSha, patch, sha256: sha256Bytes(patch), byteCount: patch.byteLength }, source.baseSha);
  return createDeterministicTar([
    { path: "source.tar", data: source.bytes },
    { path: "workspace.patch", data: patch },
  ]);
}

export function validatePortableCheckpointArchive(
  archive: Uint8Array,
  checkpoint: WorkspaceCheckpoint,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
): { source: CredentiallessArchive; patch: PatchManifest } {
  const manifest = normalizeWorkspaceCheckpoint(checkpoint);
  if (archive.byteLength !== manifest.archiveBytes || sha256Bytes(archive) !== manifest.archiveSha256) {
    throw new CloudWorkspaceError(manifest.provider, "digest_mismatch", "portable checkpoint bytes do not match the canonical manifest", "rejected");
  }
  const members = validatedTarMembers(archive, limits, manifest.provider);
  if (members.length !== 2 || members.some((member) => member.type !== "0")) {
    throw new CloudWorkspaceError(manifest.provider, "unsafe_archive", "portable checkpoint must contain exactly two regular members", "rejected");
  }
  const sourceMember = members.find((member) => member.path === "source.tar");
  const patchMember = members.find((member) => member.path === "workspace.patch");
  if (!sourceMember || !patchMember) {
    throw new CloudWorkspaceError(manifest.provider, "unsafe_archive", "portable checkpoint member names are invalid", "rejected");
  }
  const source: CredentiallessArchive = {
    baseSha: manifest.baseSha,
    sha256: manifest.sourceArchiveSha256,
    bytes: sourceMember.data,
  };
  if (sourceMember.size !== manifest.sourceArchiveBytes) {
    throw new CloudWorkspaceError(manifest.provider, "digest_mismatch", "portable checkpoint source byte count changed", "rejected");
  }
  validateCredentiallessArchive(source, limits, manifest.provider);
  const patch: PatchManifest = {
    baseSha: manifest.baseSha,
    patch: patchMember.data,
    sha256: sha256Bytes(patchMember.data),
    byteCount: patchMember.size,
  };
  validatePatchManifest(patch, manifest.baseSha, limits.maxArchiveBytes, manifest.provider);
  return { source, patch };
}

export type WorkspaceCheckpointBinding = {
  jobId: string;
  attempt: number;
  provider: CloudWorkspaceProviderName;
  baseSha: string;
  sourceArchiveSha256: string;
  sourceArchiveBytes: number;
  runtime: string;
  lockfileDigest: string;
  template: string;
  attemptKey: string;
  causationId: string;
};

export function assertWorkspaceCheckpointBinding(checkpoint: WorkspaceCheckpoint, expected: WorkspaceCheckpointBinding): void {
  const item = normalizeWorkspaceCheckpoint(checkpoint);
  for (const key of [
    "jobId", "attempt", "provider", "baseSha", "sourceArchiveSha256", "sourceArchiveBytes",
    "runtime", "lockfileDigest", "template", "attemptKey", "causationId",
  ] as const) {
    if (item[key] !== expected[key]) {
      throw new CloudWorkspaceError(item.provider, "checkpoint_incompatible", `checkpoint ${key} binding changed`, "rejected");
    }
  }
}

export type CheckpointStore = {
  put(manifest: WorkspaceCheckpoint, archive: Uint8Array): Promise<{ ref: string; digest: string; byteCount: number; manifest: string; manifestDigest: string }>;
  get(ref: string, digest: string, byteCount: number): Promise<Uint8Array>;
};

export class ContentAddressedCheckpointStore implements CheckpointStore {
  constructor(
    private readonly write: (key: string, value: Uint8Array, metadata: Record<string, string>) => Promise<void>,
    private readonly read: (key: string) => Promise<Uint8Array | null>,
  ) {}

  async put(manifest: WorkspaceCheckpoint, archive: Uint8Array) {
    const canonicalManifest = canonicalWorkspaceCheckpoint(manifest);
    const manifestDigest = sha256Bytes(canonicalManifest);
    validatePortableCheckpointArchive(archive, manifest);
    const digest = sha256Bytes(archive);
    if (digest !== manifest.archiveSha256 || archive.byteLength !== manifest.archiveBytes) {
      throw new CloudWorkspaceError(manifest.provider, "digest_mismatch", "checkpoint bytes do not match the immutable manifest", "rejected");
    }
    const ref = `sandbox-checkpoints/sha256/${digest}`;
    await this.write(ref, archive, {
      sha256: digest,
      bytes: String(archive.byteLength),
      provider: manifest.provider,
      runtime: manifest.runtime,
      lockfile: manifest.lockfileDigest,
      attempt: manifest.attemptKey,
      causation: manifest.causationId,
      manifest: manifestDigest,
    });
    return { ref, digest, byteCount: archive.byteLength, manifest: canonicalManifest, manifestDigest };
  }

  async get(ref: string, digest: string, byteCount: number) {
    if (ref !== `sandbox-checkpoints/sha256/${digest}`) {
      throw new CloudWorkspaceError("cloudflare", "digest_mismatch", "checkpoint reference is not content addressed", "rejected");
    }
    const value = await this.read(ref);
    if (!value) throw new CloudWorkspaceError("cloudflare", "checkpoint_missing", "R2 checkpoint object is missing", "deferred");
    if (value.byteLength !== byteCount || sha256Bytes(value) !== digest) {
      throw new CloudWorkspaceError("cloudflare", "digest_mismatch", "R2 checkpoint digest or byte count mismatch", "rejected");
    }
    return value;
  }
}

export function parseCheckpointReceiptManifest(value: string, digest: string): WorkspaceCheckpoint {
  if (sha256Bytes(value) !== digest) {
    throw new CloudWorkspaceError("cloudflare", "checkpoint_tampered", "checkpoint manifest digest changed", "rejected");
  }
  try { return parseCanonicalWorkspaceCheckpoint(value); }
  catch { throw new CloudWorkspaceError("cloudflare", "checkpoint_tampered", "checkpoint manifest is not canonical", "rejected"); }
}

export async function controllerApplyValidatedPatch(
  manifest: PatchManifest,
  expectedBaseSha: string,
  apply: (patch: Uint8Array) => Promise<void>,
): Promise<void> {
  validatePatchManifest(manifest, expectedBaseSha);
  await apply(manifest.patch);
}
