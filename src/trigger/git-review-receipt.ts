import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { redactSensitiveText } from "../lib/secret-redaction";
import type { GitCommandResult, GitCommandRunner } from "../lib/git-delivery";

const GIT_OID = /^[0-9a-f]{40,64}$/;
export const GIT_REVIEW_DIFF_MAX_CHARS = 240_000;
const COMMAND_EVIDENCE_LIMIT = 32;

export type GitCommandEvidence = Readonly<{
  command: string;
  exitCode: number | null;
  status: string;
  output: string;
}>;

export type GitReviewReceipt = Readonly<{
  version: 2;
  jobId: string;
  attempt: number;
  workOrderRevisionDigest: string;
  repository: string;
  branch: string;
  baseSha: string;
  baseTreeSha: string;
  headSha: string;
  headTreeSha: string;
  parentShas: readonly string[];
  historyComplete: true;
  baseIsAncestor: true;
  commitCount: number;
  commits: string;
  clean: true;
  diffStat: string;
  changedPaths: string;
  diffPatch: string;
  diffSha256: string;
  diffChars: number;
  agentEvidenceSha256: string;
  commands: readonly GitCommandEvidence[];
}>;

export type GitReviewBinding = Readonly<{
  jobId: string;
  attempt: number;
  workOrderRevisionDigest: string;
  repository: string;
  branch: string;
  baseSha: string;
  agentEvidenceSha256: string;
  headSha?: string;
}>;

export type GitReviewEnvelope = Readonly<{
  /** Public selector only. Key material and rotation metadata never leave the controller. */
  keyId: string;
  receipt: GitReviewReceipt;
  signature: string;
}>;

export type GitReviewReceiptKey = Readonly<{
  keyId: string;
  secret: Uint8Array | string;
}>;

type BuildReceiptInput = {
  runGit: GitCommandRunner;
  jobId: string;
  attempt: number;
  workOrderRevisionDigest: string;
  repository: string;
  expectedBranch: string;
  baseSha: string;
  expectedHeadSha?: string;
  agentEvidence: string;
  commands?: readonly GitCommandEvidence[];
};

type BuildReceiptResult =
  | { ok: true; receipt: GitReviewReceipt; binding: GitReviewBinding }
  | { ok: false; note: string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(-300);
}

async function requiredGit(
  runGit: GitCommandRunner,
  args: string[],
  label: string,
): Promise<GitCommandResult & { value: string }> {
  const result = await runGit(args);
  const value = result.out.trim();
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${oneLine(result.out) || `git exited ${String(result.code)}`}`);
  }
  return { ...result, value };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function receiptJson(receipt: GitReviewReceipt): string {
  return JSON.stringify(receipt);
}

/** Capture completed Codex command events as controller-observed test evidence. */
export function commandEvidenceFromCodexEvent(
  event: any,
  environment: Readonly<Record<string, string | undefined>> = {},
): GitCommandEvidence | null {
  if (event?.type !== "item.completed" || event?.item?.type !== "command_execution") return null;
  const item = event.item;
  const rawExit = item.exit_code ?? item.exitCode;
  const exitCode = Number.isFinite(Number(rawExit)) ? Number(rawExit) : null;
  const rawOutput = item.aggregated_output ?? item.output ?? item.stdout ?? "";
  return deepFreeze({
    command: redactSensitiveText(String(item.command ?? "command"), environment).slice(0, 800),
    exitCode,
    status: String(item.status ?? (exitCode === 0 ? "completed" : "failed")).slice(0, 40),
    output: redactSensitiveText(String(rawOutput), environment).slice(-2_000),
  });
}

/**
 * Build a receipt only from the controller's hydrated checkout. No path,
 * credential, remote URL or mutable file is included in the model payload.
 */
export async function buildGitReviewReceipt(input: BuildReceiptInput): Promise<BuildReceiptResult> {
  try {
    if (!/^[0-9a-f]{64}$/.test(input.workOrderRevisionDigest)) {
      return { ok: false, note: "work-order revision digest is invalid" };
    }
    const shallow = await requiredGit(input.runGit, ["rev-parse", "--is-shallow-repository"], "history depth");
    if (shallow.value !== "false") {
      return { ok: false, note: "review checkout history is shallow; parent and ancestry claims are unverifiable" };
    }

    const branch = await requiredGit(input.runGit, ["branch", "--show-current"], "branch identity");
    if (!branch.value || branch.value !== input.expectedBranch) {
      return {
        ok: false,
        note: `review checkout branch mismatch: expected ${input.expectedBranch}, found ${branch.value || "detached HEAD"}`,
      };
    }

    const baseSha = input.baseSha.trim();
    if (!GIT_OID.test(baseSha)) return { ok: false, note: "review checkout base commit is invalid" };
    const head = await requiredGit(input.runGit, ["rev-parse", "HEAD"], "head identity");
    if (!GIT_OID.test(head.value)) return { ok: false, note: "review checkout head commit is invalid" };
    if (input.expectedHeadSha && head.value !== input.expectedHeadSha.trim()) {
      return { ok: false, note: "review checkout head changed after controller delivery preparation" };
    }

    const ancestry = await input.runGit(["merge-base", "--is-ancestor", baseSha, head.value]);
    if (ancestry.code !== 0) {
      return {
        ok: false,
        note: ancestry.code === 1
          ? "review checkout head does not descend from its prepared base"
          : `review checkout ancestry could not be verified: ${oneLine(ancestry.out)}`,
      };
    }

    const [baseTree, headTree, parents, count, commits, status, stat, paths, patch] = await Promise.all([
      requiredGit(input.runGit, ["rev-parse", `${baseSha}^{tree}`], "base tree"),
      requiredGit(input.runGit, ["rev-parse", "HEAD^{tree}"], "head tree"),
      requiredGit(input.runGit, ["show", "-s", "--format=%P", head.value], "head parents"),
      requiredGit(input.runGit, ["rev-list", "--count", `${baseSha}..${head.value}`], "commit count"),
      requiredGit(
        input.runGit,
        ["log", "--reverse", "--format=%H%x09%P%x09%s", `${baseSha}..${head.value}`],
        "commit list",
      ),
      requiredGit(input.runGit, ["status", "--porcelain=v1", "--untracked-files=all"], "checkout status"),
      requiredGit(input.runGit, ["diff", "--no-ext-diff", "--stat", "--summary", `${baseSha}..${head.value}`], "diff stat"),
      requiredGit(input.runGit, ["diff", "--no-ext-diff", "--name-status", `${baseSha}..${head.value}`], "changed paths"),
      requiredGit(
        input.runGit,
        ["diff", "--no-ext-diff", "--no-color", "--full-index", "--unified=3", `${baseSha}..${head.value}`],
        "diff patch",
      ),
    ]);

    if (status.value) return { ok: false, note: "review checkout contains uncommitted or untracked changes" };
    if (!GIT_OID.test(baseTree.value) || !GIT_OID.test(headTree.value)) {
      return { ok: false, note: "review checkout tree identity is invalid" };
    }
    const parentShas = parents.value ? parents.value.split(/\s+/) : [];
    if (parentShas.some((parent) => !GIT_OID.test(parent))) {
      return { ok: false, note: "review checkout parent identity is invalid" };
    }
    const commitCount = Number(count.value);
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
      return { ok: false, note: "review checkout commit count is invalid" };
    }
    if (patch.out.length > GIT_REVIEW_DIFF_MAX_CHARS) {
      return {
        ok: false,
        note: `review diff exceeds the integrity receipt limit (${patch.out.length} characters)`,
      };
    }

    const safeEvidence = redactSensitiveText(input.agentEvidence);
    const receipt: GitReviewReceipt = deepFreeze({
      version: 2,
      jobId: input.jobId.slice(0, 160),
      attempt: Math.max(1, Math.floor(input.attempt)),
      workOrderRevisionDigest: input.workOrderRevisionDigest,
      repository: input.repository.slice(0, 160),
      branch: branch.value.slice(0, 240),
      baseSha,
      baseTreeSha: baseTree.value,
      headSha: head.value,
      headTreeSha: headTree.value,
      parentShas,
      historyComplete: true,
      baseIsAncestor: true,
      commitCount,
      commits: redactSensitiveText(commits.out).slice(0, 30_000),
      clean: true,
      diffStat: redactSensitiveText(stat.out).slice(0, 20_000),
      changedPaths: redactSensitiveText(paths.out).slice(0, 30_000),
      diffPatch: redactSensitiveText(patch.out),
      diffSha256: sha256(patch.out),
      diffChars: patch.out.length,
      agentEvidenceSha256: sha256(safeEvidence),
      commands: [...(input.commands ?? [])].slice(-COMMAND_EVIDENCE_LIMIT).map((command) => deepFreeze({ ...command })),
    });
    const binding: GitReviewBinding = deepFreeze({
      jobId: receipt.jobId,
      attempt: receipt.attempt,
      workOrderRevisionDigest: receipt.workOrderRevisionDigest,
      repository: receipt.repository,
      branch: receipt.branch,
      baseSha: receipt.baseSha,
      agentEvidenceSha256: receipt.agentEvidenceSha256,
      headSha: receipt.headSha,
    });
    return { ok: true, receipt, binding };
  } catch (error) {
    return { ok: false, note: String(error instanceof Error ? error.message : error).slice(0, 500) };
  }
}

/**
 * The authority is controller configuration, never per-process randomness.
 * Callers must fail closed when the Trigger-only secret is unavailable; a
 * random key would make a resumed delivery unverifiable.
 */
export function createGitReviewReceiptKeyring(
  current: GitReviewReceiptKey,
  previous: readonly GitReviewReceiptKey[] = [],
) {
  const keyIdPattern = /^[a-zA-Z0-9._-]{1,64}$/;
  const entries = [current, ...previous];
  if (!keyIdPattern.test(current.keyId)) throw new Error("Git review receipt key id is invalid");
  if (new Set(entries.map((entry) => entry.keyId)).size !== entries.length) {
    throw new Error("Git review receipt key ids must be unique");
  }
  const keys = new Map(entries.map((entry) => {
    if (!keyIdPattern.test(entry.keyId)) throw new Error("Git review receipt key id is invalid");
    const key = Buffer.from(entry.secret);
    if (key.length < 32) throw new Error("Git review receipt authority requires at least 32 bytes");
    return [entry.keyId, key] as const;
  }));

  const sign = (receipt: GitReviewReceipt, key: Buffer) => createHmac("sha256", key).update(receiptJson(receipt)).digest("hex");
  const matchesBinding = (receipt: GitReviewReceipt, expected: GitReviewBinding) =>
    receipt.jobId === expected.jobId
    && receipt.attempt === expected.attempt
    && receipt.workOrderRevisionDigest === expected.workOrderRevisionDigest
    && receipt.repository === expected.repository
    && receipt.branch === expected.branch
    && receipt.baseSha === expected.baseSha
    && receipt.agentEvidenceSha256 === expected.agentEvidenceSha256
    && (!expected.headSha || receipt.headSha === expected.headSha);

  return {
    issue(receipt: GitReviewReceipt): GitReviewEnvelope {
      const immutable = deepFreeze(JSON.parse(receiptJson(receipt)) as GitReviewReceipt);
      return deepFreeze({ keyId: current.keyId, receipt: immutable, signature: sign(immutable, keys.get(current.keyId)!) });
    },
    verify(envelope: GitReviewEnvelope, expected: GitReviewBinding): boolean {
      if (!matchesBinding(envelope.receipt, expected) || !/^[0-9a-f]{64}$/.test(envelope.signature)) return false;
      const key = keys.get(envelope.keyId);
      // Unknown and retired key ids are indistinguishable and fail closed.
      if (!key) return false;
      const actual = Buffer.from(envelope.signature, "hex");
      const wanted = Buffer.from(sign(envelope.receipt, key), "hex");
      return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    },
    render(envelope: GitReviewEnvelope, expected: GitReviewBinding): string {
      if (!this.verify(envelope, expected)) throw new Error("Git review receipt integrity or job binding failed");
      return JSON.stringify({
        integrity: "controller-hmac-sha256-verified",
        keyId: envelope.keyId,
        receipt: envelope.receipt,
        signature: envelope.signature,
      });
    },
  };
}

/** Compatibility constructor for one current signer; new configuration uses an explicit keyring. */
export function createGitReviewReceiptAuthority(secret: Uint8Array | string, keyId = "legacy-v1") {
  return createGitReviewReceiptKeyring({ keyId, secret });
}
