import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GitCommandRunner } from "../lib/git-delivery";

export const VERCEL_CONFIG_SCHEMA = "https://openapi.vercel.sh/vercel.json";

export type GitDeploymentFenceAttestation = Readonly<{
  schemaVersion: 1;
  changed: boolean;
  configSha256: string;
}>;

export class GitDeploymentFenceError extends Error {
  constructor(
    readonly code:
      | "programmatic_config"
      | "invalid_json"
      | "invalid_root"
      | "invalid_git"
      | "unsafe_path"
      | "write_failed"
      | "staging_failed"
      | "commit_failed"
      | "verification_failed",
    readonly repair: string,
  ) {
    super(`Git deployment fence ${code}: ${repair}`);
    this.name = "GitDeploymentFenceError";
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const pathStat = (path: string) => {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

function parseConfig(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GitDeploymentFenceError(
      "invalid_json",
      "repair the root vercel.json so it is valid JSON; the controller will not replace ambiguous content",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitDeploymentFenceError(
      "invalid_root",
      "repair the root vercel.json so its root is a JSON object",
    );
  }
  const config = parsed as Record<string, unknown>;
  if (own(config, "git") && (!config.git || typeof config.git !== "object" || Array.isArray(config.git))) {
    throw new GitDeploymentFenceError(
      "invalid_git",
      "repair vercel.json so git is an object whose unrelated nested options can be preserved safely",
    );
  }
  return config;
}

function attestConfig(bytes: Buffer, changed: boolean): GitDeploymentFenceAttestation {
  const config = parseConfig(bytes);
  const git = config.git as Record<string, unknown> | undefined;
  if (!own(config, "$schema") || !git || git.deploymentEnabled !== false) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      `set the root vercel.json schema and git.deploymentEnabled to false before Git delivery`,
    );
  }
  return { schemaVersion: 1, changed, configSha256: sha256(bytes) };
}

/** Pure content attestation used for the exact committed Git blob. */
export function attestGitDeploymentFenceContent(content: string | Buffer): GitDeploymentFenceAttestation {
  return attestConfig(Buffer.isBuffer(content) ? content : Buffer.from(content), false);
}

/**
 * Materialize the portfolio-wide fence in a trusted controller checkout.
 * Existing JSON objects retain all unrelated fields and nested Git options.
 */
export function ensureGitDeploymentFence(checkout: string): GitDeploymentFenceAttestation {
  const configPath = join(checkout, "vercel.json");
  const programmaticPath = join(checkout, "vercel.ts");
  if (pathStat(programmaticPath)) {
    throw new GitDeploymentFenceError(
      "programmatic_config",
      "remove or explicitly reconcile the competing root vercel.ts configuration before delivery",
    );
  }

  let original: Buffer | null = null;
  let mode = 0o644;
  const configStat = pathStat(configPath);
  if (configStat) {
    const stat = configStat;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new GitDeploymentFenceError(
        "unsafe_path",
        "replace the root vercel.json path with a regular file inside the repository checkout",
      );
    }
    mode = stat.mode & 0o777;
    original = readFileSync(configPath);
  }

  const config = original ? parseConfig(original) : {};
  const existingGit = (config.git as Record<string, unknown> | undefined) ?? {};
  if (original && own(config, "$schema") && existingGit.deploymentEnabled === false) {
    return attestConfig(original, false);
  }
  const materialized: Record<string, unknown> = own(config, "$schema")
    ? { ...config, git: { ...existingGit, deploymentEnabled: false } }
    : { $schema: VERCEL_CONFIG_SCHEMA, ...config, git: { ...existingGit, deploymentEnabled: false } };
  const rendered = Buffer.from(`${JSON.stringify(materialized, null, 2)}\n`);

  if (original?.equals(rendered)) return attestConfig(original, false);

  const temporaryPath = join(checkout, `.vercel.json.jarvis-fence-${process.pid}`);
  try {
    writeFileSync(temporaryPath, rendered, { encoding: "utf8", flag: "wx", mode });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* no temporary file to clean */ }
    throw new GitDeploymentFenceError(
      "write_failed",
      `make the controller checkout writable and retry the vercel.json fence (${String(error).slice(0, 180)})`,
    );
  }

  let observed: Buffer;
  try {
    observed = readFileSync(configPath);
  } catch (error) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      `restore readable root vercel.json bytes and retry (${String(error).slice(0, 180)})`,
    );
  }
  if (!observed.equals(rendered)) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      "the root vercel.json changed during controller materialization; retry from the portable checkpoint",
    );
  }
  return attestConfig(observed, true);
}

/** Attest the exact HEAD tree rather than trusting mutable worktree bytes. */
export async function attestCommittedGitDeploymentFence(
  runGit: GitCommandRunner,
): Promise<GitDeploymentFenceAttestation> {
  const programmatic = await runGit(["ls-tree", "--name-only", "HEAD", "--", "vercel.ts"]);
  if (programmatic.code !== 0) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      "the controller could not inspect the committed tree for a competing vercel.ts",
    );
  }
  if (programmatic.out.trim()) {
    throw new GitDeploymentFenceError(
      "programmatic_config",
      "remove or explicitly reconcile the committed root vercel.ts configuration before delivery",
    );
  }
  const config = await runGit(["show", "HEAD:vercel.json"]);
  if (config.code !== 0) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      "commit an attested root vercel.json before remote observation or push",
    );
  }
  return attestGitDeploymentFenceContent(config.out);
}

/** Attest root configuration from one exact Git tree and blob, never worktree bytes. */
export async function attestGitDeploymentFenceTree(
  runGit: GitCommandRunner,
  readGitObject: (sha: string) => Promise<Buffer>,
  treeSha: string,
): Promise<GitDeploymentFenceAttestation> {
  if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) {
    throw new GitDeploymentFenceError("verification_failed", "the candidate tree identity is invalid");
  }
  const listed = await runGit(["ls-tree", "-z", treeSha, "--", "vercel.json", "vercel.ts"]);
  if (listed.code !== 0) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      "the controller could not inspect the exact candidate tree for deployment configuration",
    );
  }
  const entries = listed.out.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(vercel\.json|vercel\.ts)$/.exec(line);
    if (!match) {
      throw new GitDeploymentFenceError("verification_failed", "the candidate deployment configuration entry is malformed");
    }
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
  if (entries.some((entry) => entry.path === "vercel.ts")) {
    throw new GitDeploymentFenceError(
      "programmatic_config",
      "remove or explicitly reconcile the competing root vercel.ts configuration in the candidate tree",
    );
  }
  const config = entries.find((entry) => entry.path === "vercel.json");
  if (!config || config.type !== "blob" || !["100644", "100755"].includes(config.mode)) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      "the candidate tree must contain a regular root vercel.json blob",
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readGitObject(config.sha);
  } catch (error) {
    throw new GitDeploymentFenceError(
      "verification_failed",
      `the exact candidate vercel.json blob is unreadable (${String(error).slice(0, 180)})`,
    );
  }
  return attestGitDeploymentFenceContent(bytes);
}

export type GitDeploymentFenceGate = Readonly<{
  headSha: string;
  observeRemote(args: string[]): Promise<Awaited<ReturnType<GitCommandRunner>>>;
  push(args: string[]): Promise<Awaited<ReturnType<GitCommandRunner>>>;
}>;

/**
 * Materialize, stage, commit, and attest the fence before exposing either
 * executable remote-observation or push capability to the delivery caller.
 */
export async function withGitDeploymentFence<T>(input: {
  checkout: string;
  runGit: GitCommandRunner;
  commitMessage: string;
  deliver(gate: GitDeploymentFenceGate): Promise<T>;
}): Promise<T> {
  ensureGitDeploymentFence(input.checkout);
  const staged = await input.runGit(["add", "-A"]);
  if (staged.code !== 0) {
    throw new GitDeploymentFenceError(
      "staging_failed",
      `repair the controller Git index before delivery (${staged.out.slice(-300)})`,
    );
  }
  const stagedDiff = await input.runGit(["diff", "--cached", "--quiet"]);
  if (stagedDiff.code === 1) {
    const committed = await input.runGit(["commit", "-m", input.commitMessage]);
    if (committed.code !== 0) {
      throw new GitDeploymentFenceError(
        "commit_failed",
        `repair the disposable controller commit failure before delivery (${committed.out.slice(-300)})`,
      );
    }
  } else if (stagedDiff.code !== 0) {
    throw new GitDeploymentFenceError(
      "staging_failed",
      `the controller could not inspect its staged diff (${stagedDiff.out.slice(-300)})`,
    );
  }
  const head = await input.runGit(["rev-parse", "HEAD"]);
  const headSha = head.out.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(headSha)) {
    throw new GitDeploymentFenceError("verification_failed", "the exact committed controller HEAD could not be attested");
  }
  await attestCommittedGitDeploymentFence(input.runGit);

  const runAttested = async (kind: "ls-remote" | "push", args: string[]) => {
    if (args[0] !== kind) {
      throw new GitDeploymentFenceError("verification_failed", `the ${kind} gate received an unexpected Git command`);
    }
    await attestCommittedGitDeploymentFence(input.runGit);
    return await input.runGit(args);
  };
  return await input.deliver({
    headSha,
    observeRemote: (args) => runAttested("ls-remote", args),
    push: (args) => runAttested("push", args),
  });
}
