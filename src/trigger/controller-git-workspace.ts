import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GitCommandResult, GitCommandRunner } from "../lib/git-delivery";

const GIT_OID = /^[0-9a-f]{40,64}$/;

export type ControllerOwnedGitWorkspace = Readonly<{
  gitDir: string;
  workTree: string;
  branch: string;
  startHead: string;
  startTree: string;
}>;

export type ControllerCommitResult = Readonly<{
  changed: boolean;
  headSha: string;
  treeSha: string;
  commitCount: 0 | 1;
}>;

function oneLine(result: GitCommandResult, label: string): string {
  const value = result.out.trim();
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${value.replace(/\s+/g, " ").slice(-300) || `git exited ${String(result.code)}`}`);
  }
  return value;
}

function trustedDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  return realpathSync(path);
}

function assertSeparated(gitDir: string, workTree: string): void {
  const metadata = trustedDirectory(gitDir, "controller Git directory");
  const workspace = trustedDirectory(workTree, "specialist worktree");
  const fromWorkspace = relative(workspace, metadata);
  if (!fromWorkspace.startsWith("..") || fromWorkspace === "") {
    throw new Error("controller Git metadata must live outside the specialist worktree");
  }
}

/**
 * Every post-specialist Git call names controller-owned metadata explicitly and
 * disables mutable ambient config, hooks, filters, pagers, and signing.
 */
export function controllerGitArgs(
  workspace: Pick<ControllerOwnedGitWorkspace, "gitDir" | "workTree">,
  args: readonly string[],
): string[] {
  assertSeparated(workspace.gitDir, workspace.workTree);
  return [
    `--git-dir=${workspace.gitDir}`,
    `--work-tree=${workspace.workTree}`,
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "credential.helper=",
    ...args.map(String),
  ];
}

/** Strip ambient Git authority while retaining an explicitly attached GitHub transport header. */
export function controllerGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "CI",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  // githubGitEnv creates only these controller-owned command-scope entries.
  const count = Number(base.GIT_CONFIG_COUNT ?? 0);
  if (Number.isSafeInteger(count) && count > 0 && count <= 8) {
    env.GIT_CONFIG_COUNT = String(count);
    for (let index = 0; index < count; index += 1) {
      const key = base[`GIT_CONFIG_KEY_${index}`];
      const value = base[`GIT_CONFIG_VALUE_${index}`];
      if (key === undefined || value === undefined) throw new Error("incomplete controller Git transport config");
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    }
  }
  env.PATH = String(env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  env.HOME = String(env.HOME ?? "/tmp");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";
  env.GIT_EXTERNAL_DIFF = "";
  env.GIT_AUTHOR_NAME = "JARVIS delivery controller";
  env.GIT_AUTHOR_EMAIL = "jarvis-controller@daniels-project-space.dev";
  env.GIT_COMMITTER_NAME = "JARVIS delivery controller";
  env.GIT_COMMITTER_EMAIL = "jarvis-controller@daniels-project-space.dev";
  return env;
}

/** Remove fake metadata a model may create; real metadata is never below this tree. */
export function removeModelGitMetadata(workTree: string): void {
  const root = trustedDirectory(workTree, "specialist worktree");
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > 250_000) throw new Error("specialist worktree exceeds the Git normalization boundary");
      const path = join(directory, entry.name);
      if (entry.name === ".git") {
        rmSync(path, { recursive: true, force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path);
      }
    }
  }
}

export async function captureControllerGitWorkspace(input: {
  gitDir: string;
  workTree: string;
  expectedBranch: string;
  expectedHead: string;
  runGit: GitCommandRunner;
}): Promise<ControllerOwnedGitWorkspace> {
  assertSeparated(input.gitDir, input.workTree);
  const [headResult, branchResult, treeResult, indexResult, statusResult] = await Promise.all([
    input.runGit(["rev-parse", "HEAD"]),
    input.runGit(["branch", "--show-current"]),
    input.runGit(["rev-parse", "HEAD^{tree}"]),
    input.runGit(["write-tree"]),
    input.runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const head = oneLine(headResult, "starting HEAD");
  const branch = oneLine(branchResult, "starting branch");
  const tree = oneLine(treeResult, "starting tree");
  const indexTree = oneLine(indexResult, "starting index tree");
  const status = oneLine(statusResult, "starting worktree status");
  if (
    !GIT_OID.test(head)
    || head !== input.expectedHead
    || branch !== input.expectedBranch
    || !GIT_OID.test(tree)
    || tree !== indexTree
    || status
  ) throw new Error("specialist checkout did not start at the exact clean controller HEAD, branch, and tree");
  return Object.freeze({
    gitDir: realpathSync(input.gitDir),
    workTree: realpathSync(input.workTree),
    branch,
    startHead: head,
    startTree: tree,
  });
}

/**
 * Validate untouched controller metadata, normalize the model's file tree, and
 * create at most one hook-free controller-authored commit with commit-tree.
 */
export async function createControllerCommit(input: {
  workspace: ControllerOwnedGitWorkspace;
  message: string;
  runGit: GitCommandRunner;
}): Promise<ControllerCommitResult> {
  const { workspace } = input;
  assertSeparated(workspace.gitDir, workspace.workTree);
  const [headResult, branchResult, treeResult, indexResult] = await Promise.all([
    input.runGit(["rev-parse", "HEAD"]),
    input.runGit(["branch", "--show-current"]),
    input.runGit(["rev-parse", "HEAD^{tree}"]),
    input.runGit(["write-tree"]),
  ]);
  if (
    oneLine(headResult, "controller HEAD") !== workspace.startHead
    || oneLine(branchResult, "controller branch") !== workspace.branch
    || oneLine(treeResult, "controller tree") !== workspace.startTree
    || oneLine(indexResult, "controller index") !== workspace.startTree
  ) throw new Error("controller Git metadata changed while the specialist was running");

  removeModelGitMetadata(workspace.workTree);
  oneLine(await input.runGit(["reset", "--mixed", "--quiet", workspace.startHead]), "controller index reset");
  oneLine(await input.runGit(["add", "--all", "--", "."]), "controller tree normalization");
  const tree = oneLine(await input.runGit(["write-tree"]), "normalized tree");
  if (!GIT_OID.test(tree)) throw new Error("controller normalization did not produce a tree object");
  if (tree === workspace.startTree) {
    oneLine(await input.runGit(["reset", "--hard", "--quiet", workspace.startHead]), "clean tree restore");
    return { changed: false, headSha: workspace.startHead, treeSha: tree, commitCount: 0 };
  }

  const message = input.message.trim().replace(/\0/g, "").slice(0, 240) || "chore: controller-owned specialist changes";
  const commit = oneLine(
    await input.runGit(["commit-tree", tree, "-p", workspace.startHead, "-m", message]),
    "controller commit creation",
  );
  if (!GIT_OID.test(commit)) throw new Error("controller commit-tree returned an invalid commit");
  oneLine(
    await input.runGit(["update-ref", `refs/heads/${workspace.branch}`, commit, workspace.startHead]),
    "controller branch update",
  );
  oneLine(await input.runGit(["reset", "--hard", "--quiet", commit]), "committed tree normalization");
  const [countResult, committedTreeResult, statusResult] = await Promise.all([
    input.runGit(["rev-list", "--count", `${workspace.startHead}..${commit}`]),
    input.runGit(["rev-parse", `${commit}^{tree}`]),
    input.runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (
    oneLine(countResult, "controller commit count") !== "1"
    || oneLine(committedTreeResult, "controller committed tree") !== tree
    || oneLine(statusResult, "controller committed status")
  ) throw new Error("controller commit did not normalize exactly one clean tree transition");
  return { changed: true, headSha: commit, treeSha: tree, commitCount: 1 };
}

export function controllerMetadataIsOutsideWorkspace(gitDir: string, workTree: string): boolean {
  try {
    const rel = relative(resolve(workTree), resolve(gitDir));
    return rel.startsWith("..") && rel !== "";
  } catch {
    return false;
  }
}
