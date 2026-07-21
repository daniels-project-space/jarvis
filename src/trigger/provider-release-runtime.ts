import { configure, runs, tasks } from "@trigger.dev/sdk/v3";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  analyseProviderImpact,
  buildProviderReleasePlan,
  runPostMergeReleaseBarrier,
  runProviderReleaseBarrier,
  vercelLiveDeploymentMismatch,
  vercelProjectIdentityMismatch,
  type ProviderBarrierResult,
  type ProviderLiveBarrierResult,
  type ProviderReleasePlan,
  type ProviderReleaseState,
  type ProviderReleaseStep,
  type ProviderStepReceipt,
  type VercelAliasObservation,
  type VercelDeploymentObservation,
  type VercelProjectObservation,
} from "../lib/provider-release";
import type {
  ConvexReleaseTarget,
  ReleaseCapabilityRef,
} from "../lib/project-registry";
import { githubGitEnv, githubRepoUrl } from "./git-transport";
import type { ProviderMergeGate, PullRequestChange } from "./github-delivery";
import { vaultService } from "../lib/vault-client";
import {
  ProviderCandidateSandbox,
  createProviderToolSession,
  safeProviderToolEnv,
  type ProviderCommandResult,
  type ProviderToolSession,
} from "./provider-command-sandbox";

export { createProviderToolSession, safeProviderToolEnv } from "./provider-command-sandbox";

type ConvexMutation = (path: string, args: unknown) => Promise<any>;
type CommandResult = { code: number | null; out: string };
export type CommandRunnerLifecycleEvent = "error" | "timeout" | "close" | "resolve";
type CommandRunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onLifecycleEvent?: (event: CommandRunnerLifecycleEvent) => void;
};
type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => Promise<CommandResult>;

export const CONVEX_PREMERGE_PROOF_COMMAND = [
  "--no-install", "convex", "deploy", "--dry-run", "--typecheck", "enable",
  "--codegen", "disable", "--env-file", "/dev/null",
] as const;

export function convexReleaseAction(phase: ProviderReleaseStep["phase"]): "local-proof" | "live-deploy" {
  return phase === "premerge" ? "local-proof" : "live-deploy";
}

export function convexPremergeReceiptProvesNoMutation(result: ProviderCommandResult): boolean {
  const receipt = result.receipt;
  return receipt.protocol === 1
    && receipt.candidateSandbox === true
    && receipt.executable === "npx"
    && receipt.capability === "CONVEX_DEPLOY_KEY"
    && receipt.closeObserved === true
    && receipt.timedOut === false
    && receipt.closedAt >= receipt.startedAt
    && /^[0-9a-f]{64}$/.test(receipt.commandDigest)
    && receipt.argv.length === CONVEX_PREMERGE_PROOF_COMMAND.length
    && receipt.argv.every((value, index) => value === CONVEX_PREMERGE_PROOF_COMMAND[index])
    && receipt.argv.includes("--dry-run")
    && !receipt.argv.includes("--yes");
}

export async function installDependenciesInPinnedCheckout(input: {
  sourceSha: string;
  verifyPinned: (sourceSha: string) => Promise<string>;
  runNpmCi: (cwd: string) => Promise<void>;
}): Promise<string> {
  const before = await input.verifyPinned(input.sourceSha);
  await input.runNpmCi(before);
  const after = await input.verifyPinned(input.sourceSha);
  if (after !== before) throw new Error("dependency install changed the pinned checkout identity");
  return after;
}

export type TrustedProviderReleaseGateArgs = {
  jobId: string;
  expectedAttempt: number;
  repository: string;
  branch: string;
  prior?: ProviderReleaseState;
  githubToken: string;
  baseEnv: NodeJS.ProcessEnv;
  convexMutation: ConvexMutation;
  shouldContinue?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  runCommand?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
};

const JARVIS_SANDBOX_SMOKE_TASK = "jarvis-specialist-sandbox-smoke";
const CONVEX_ATTESTOR_FILE = "convex/_jarvisRelease.ts";
const PARSED_SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/i;
const TERMINAL_TRIGGER_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "EXPIRED",
]);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function linuxDescendants(rootPid: number): number[] {
  if (process.platform !== "linux" || !Number.isInteger(rootPid) || rootPid < 1) return [];
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end < 0) continue;
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const parent = Number(fields[1]);
      if (!Number.isInteger(parent) || parent < 1) continue;
      const existing = children.get(parent) ?? [];
      existing.push(pid);
      children.set(parent, existing);
    } catch { /* process exited during the bounded snapshot */ }
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (pending.length && descendants.length < 4_096) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function killTimedOutProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "linux") {
    // Stop the root first so it cannot race another fork. Re-snapshot while
    // stopping every observed descendant, including children in new sessions.
    try { process.kill(pid, "SIGSTOP"); } catch { /* already exited */ }
    let prior = "";
    for (let pass = 0; pass < 8; pass += 1) {
      const descendants = linuxDescendants(pid).sort((a, b) => a - b);
      for (const childPid of descendants) {
        try { process.kill(childPid, "SIGSTOP"); } catch { /* raced exit */ }
      }
      const signature = descendants.join(",");
      if (signature === prior) break;
      prior = signature;
    }
    const descendants = linuxDescendants(pid).reverse();
    for (const childPid of descendants) {
      try { process.kill(childPid, "SIGKILL"); } catch { /* raced exit */ }
    }
  }
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* process group already gone */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function oneLine(value: string, limit = 500): string {
  return value.trim().replace(/\s+/g, " ").slice(-limit);
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let processError: Error | undefined;
    let timedOut = false;
    const outputLimit = command === "git" && args[0] === "ls-files" ? 10 * 1024 * 1024 : 30_000;
    const timer = setTimeout(() => {
      timedOut = true;
      options.onLifecycleEvent?.("timeout");
      killTimedOutProcessTree(child.pid);
      try { child.kill("SIGKILL"); } catch { /* CLOSE remains the barrier */ }
    }, options.timeoutMs);
    timer.unref?.();
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-outputLimit);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      processError = error;
      options.onLifecycleEvent?.("error");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (processError) output = `${output}\n${processError.message}`;
      options.onLifecycleEvent?.("close");
      options.onLifecycleEvent?.("resolve");
      resolve({ code: timedOut || processError ? -1 : code, out: output });
    });
  });
}

export function triggerReleaseEnv(
  base: NodeJS.ProcessEnv,
  accessToken: string,
  session: ProviderToolSession,
): NodeJS.ProcessEnv {
  return {
    ...safeProviderToolEnv(base, session),
    TRIGGER_ACCESS_TOKEN: accessToken,
  };
}

export function triggerDeployCommand(projectRef: string): string[] {
  return [
    "--no-install",
    "trigger.dev",
    "deploy",
    "--project-ref",
    projectRef,
    "--env-file",
    "/dev/null",
    "--skip-promotion",
    "--skip-sync-env-vars",
  ];
}

export function triggerPromoteCommand(projectRef: string, version: string): string[] {
  return ["--no-install", "trigger.dev", "promote", version, "--project-ref", projectRef];
}

export type GeneratedTriggerAttestor = Readonly<{
  taskId: string;
  relativePath: string;
  source: string;
}>;

export function generatedTriggerAttestor(input: {
  releaseId: string;
  sourceSha: string;
  projectRef: string;
}): GeneratedTriggerAttestor {
  if (!/^providers-v2:[0-9a-f]{64}$/.test(input.releaseId)) throw new Error("invalid generated attestor release id");
  if (!/^[0-9a-f]{40,64}$/i.test(input.sourceSha)) throw new Error("invalid generated attestor source SHA");
  if (!/^proj_[a-z0-9]+$/i.test(input.projectRef)) throw new Error("invalid generated attestor project ref");
  const suffix = createHash("sha256")
    .update(`${input.releaseId}\0${input.sourceSha}\0${input.projectRef}`)
    .digest("hex")
    .slice(0, 20);
  const taskId = `provider-release-attestor-${suffix}`;
  const relativePath = `src/trigger/__provider_release_attestor_${suffix}.ts`;
  const receipt = {
    protocol: 1,
    releaseId: input.releaseId,
    sourceSha: input.sourceSha,
    projectRef: input.projectRef,
    taskId,
  } as const;
  const source = `import { task } from "@trigger.dev/sdk/v3";\n\n` +
    `const RELEASE = Object.freeze(${JSON.stringify(receipt)} as const);\n\n` +
    `export const providerReleaseAttestor = task({\n` +
    `  id: RELEASE.taskId,\n  maxDuration: 60,\n  retry: { maxAttempts: 1 },\n` +
    `  run: async (payload: { protocol: number; releaseId: string; expectedSourceSha: string; expectedProjectRef: string; expectedVersion: string }, { ctx }) => {\n` +
    `    const version = String(ctx.task.version ?? "");\n` +
    `    if (payload.protocol !== RELEASE.protocol || payload.releaseId !== RELEASE.releaseId || payload.expectedSourceSha !== RELEASE.sourceSha || payload.expectedProjectRef !== RELEASE.projectRef || !version || payload.expectedVersion !== version) {\n` +
    `      throw new Error("provider release attestation does not match this immutable task bundle");\n    }\n` +
    `    return { ...RELEASE, version };\n  },\n});\n`;
  return Object.freeze({ taskId, relativePath, source });
}

function deploymentFromConvexKey(key: string): { type: string; deployment: string } | null {
  const match = key.match(/^([a-z]+):([a-z0-9-]+)\|/i);
  return match ? { type: match[1].toLowerCase(), deployment: match[2].toLowerCase() } : null;
}

function attestorSource(args: {
  releaseId: string;
  sourceSha: string;
  target: ConvexReleaseTarget;
}): string {
  return `import { query } from "./_generated/server";\nimport { v } from "convex/values";\n\n` +
    `const RECEIPT = Object.freeze(${JSON.stringify({
      protocol: 1,
      releaseId: args.releaseId,
      sourceSha: args.sourceSha,
      deployment: args.target.deployment,
      role: args.target.role,
    })});\n\n` +
    `export const attest = query({\n  args: { releaseId: v.string() },\n  handler: async (_ctx, args) => ` +
    `args.releaseId === RECEIPT.releaseId ? RECEIPT : null,\n});\n`;
}

function targetForStep(plan: ProviderReleasePlan, step: ProviderReleaseStep): ConvexReleaseTarget {
  const target = plan.boundary?.convex?.targets.find((candidate) => candidate.deployment === step.target);
  if (!target) throw new Error(`Convex target ${step.target} is absent from the trusted boundary`);
  return target;
}

function verifiedReceipt(
  step: ProviderReleaseStep,
  proof: string,
  extra: Partial<ProviderStepReceipt> = {},
): ProviderStepReceipt {
  return { id: step.id, status: "verified", proof, checkedAt: Date.now(), ...extra };
}

class BaseNotIncludedError extends Error {}

class TrustedProviderReleaseRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly runCommand: CommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly toolSession: ProviderToolSession;
  private readonly leaseToken = randomBytes(24).toString("hex");
  private readonly services = new Map<string, Promise<Record<string, string>>>();
  private checkoutDir: string | null = null;
  private checkoutSourceSha = "";
  private dependenciesSourceSha = "";
  private readonly convexProofs = new Map<string, { commandDigest: string }>();
  private candidateSandbox: ProviderCandidateSandbox | null = null;
  private releaseLeaseBegun = false;
  private currentState: ProviderReleaseState | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatPromise: Promise<boolean> | undefined;
  private heartbeatFailure = "";
  private cleaned = false;

  constructor(
    private readonly args: TrustedProviderReleaseGateArgs,
    private readonly change: PullRequestChange,
    private plan: ProviderReleasePlan,
  ) {
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.runCommand = args.runCommand ?? defaultCommandRunner;
    this.sleep = args.sleep ?? delay;
    this.toolSession = createProviderToolSession(args.baseEnv);
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeatPromise?.catch(() => false);
    await this.candidateSandbox?.cleanup();
    this.candidateSandbox = null;
    if (this.checkoutDir) rmSync(resolve(this.checkoutDir, ".."), { recursive: true, force: true });
    this.checkoutDir = null;
    this.toolSession.cleanup();
  }

  private async continuing(): Promise<void> {
    if (this.heartbeatFailure) throw new Error(this.heartbeatFailure);
    if (this.args.shouldContinue && !(await this.args.shouldContinue())) {
      throw new Error("the trusted delivery lease ended during provider release");
    }
  }

  private service(name: string): Promise<Record<string, string>> {
    let pending = this.services.get(name);
    if (!pending) {
      pending = vaultService(name);
      this.services.set(name, pending);
    }
    return pending;
  }

  private toolEnv(): NodeJS.ProcessEnv {
    return safeProviderToolEnv(this.args.baseEnv, this.toolSession);
  }

  private async ensureCandidatePreflight(): Promise<ProviderCandidateSandbox> {
    const dir = this.checkoutDir ?? await this.checkout();
    if (!this.candidateSandbox) {
      this.candidateSandbox = new ProviderCandidateSandbox({
        checkout: dir,
        baseEnv: this.args.baseEnv,
        session: this.toolSession,
      });
    }
    await this.candidateSandbox.preflight();
    return this.candidateSandbox;
  }

  private async capability(reference: ReleaseCapabilityRef): Promise<string> {
    // No target authority is loaded until the real namespace/chroot preflight
    // has closed and its atomic receipt has been validated.
    await this.ensureCandidatePreflight();
    const fromEnv = reference.env ? this.args.baseEnv[reference.env] : undefined;
    if (fromEnv?.trim()) return fromEnv.trim();
    const values = await this.service(reference.service).catch(() => ({} as Record<string, string>));
    const value = values[reference.key]?.trim();
    if (!value) throw new Error(`trusted release capability ${reference.service}.${reference.key} is unavailable`);
    return value;
  }

  private async candidateCommand(input: {
    command: "npm" | "npx";
    args: readonly string[];
    timeoutMs: number;
    capability?: { name: "CONVEX_DEPLOY_KEY" | "TRIGGER_ACCESS_TOKEN"; value: string };
  }): Promise<ProviderCommandResult> {
    await this.continuing();
    const sandbox = await this.ensureCandidatePreflight();
    const result = await sandbox.run(input);
    await this.continuing();
    return result;
  }

  private candidateOutput(result: ProviderCommandResult, label: string): string {
    if (
      result.code !== 0
      || result.receipt.protocol !== 1
      || result.receipt.candidateSandbox !== true
      || result.receipt.closeObserved !== true
      || result.receipt.timedOut
    ) {
      throw new Error(`${label} failed inside the candidate sandbox: ${oneLine(result.out) || `exit ${String(result.code)}`}`);
    }
    return result.out;
  }

  private async command(
    command: string,
    commandArgs: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs = 15 * 60_000,
  ): Promise<string> {
    await this.continuing();
    const result = await this.runCommand(command, commandArgs, { cwd, env, timeoutMs });
    if (result.code !== 0) {
      throw new Error(`${command} failed: ${oneLine(result.out) || `exit ${String(result.code)}`}`);
    }
    await this.continuing();
    return result.out;
  }

  private async checkout(initialBranch = this.args.branch, expectedSha = this.plan.headSha): Promise<string> {
    if (this.checkoutDir) return this.checkoutDir;
    const root = mkdtempSync(join(tmpdir(), "jarvis-provider-release-"));
    const dir = join(root, "repository");
    const gitEnv = githubGitEnv(this.toolEnv(), this.args.githubToken);
    try {
      await this.command(
        "git",
        ["clone", "--no-tags", "--single-branch", "--branch", initialBranch, githubRepoUrl(this.args.repository), dir],
        root,
        gitEnv,
      );
      await this.command("git", ["remote", "set-url", "origin", githubRepoUrl(this.args.repository)], dir, this.toolEnv());
      const head = oneLine(await this.command("git", ["rev-parse", "HEAD"], dir, this.toolEnv()), 80);
      const branch = oneLine(await this.command("git", ["branch", "--show-current"], dir, this.toolEnv()), 240);
      const shallow = oneLine(await this.command("git", ["rev-parse", "--is-shallow-repository"], dir, this.toolEnv()), 20);
      const status = (await this.command("git", ["status", "--porcelain=v1", "--untracked-files=all"], dir, this.toolEnv())).trim();
      if (head !== expectedSha || branch !== initialBranch || shallow !== "false" || status) {
        throw new Error("the trusted provider checkout is not the exact clean, complete-history source candidate");
      }
      this.checkoutDir = dir;
      this.checkoutSourceSha = expectedSha;
      return dir;
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async remoteRefs(): Promise<Map<string, string>> {
    const dir = this.checkoutDir ?? await this.checkout();
    const env = this.toolEnv();
    const output = await this.command(
      "git",
      [
        "ls-remote",
        githubRepoUrl(this.args.repository),
        `refs/heads/${this.args.branch}`,
        `refs/heads/${this.change.baseBranch}`,
      ],
      dir,
      githubGitEnv(env, this.args.githubToken),
    );
    const refs = new Map<string, string>();
    for (const line of output.trim().split(/\r?\n/)) {
      const [sha, ref] = line.trim().split(/\s+/, 2);
      if (sha && ref) refs.set(ref, sha);
    }
    return refs;
  }

  private async verifyRemoteIdentity(sourceSha: string): Promise<void> {
    const refs = await this.remoteRefs();
    const baseRef = `refs/heads/${this.change.baseBranch}`;
    if (sourceSha === this.plan.headSha) {
      if (
        refs.get(`refs/heads/${this.args.branch}`) !== this.plan.headSha
        || refs.get(baseRef) !== this.plan.baseSha
      ) throw new Error("the pull request head or pinned base changed during provider release");
      return;
    }
    if (refs.get(baseRef) !== sourceSha) {
      throw new Error("the production branch advanced before exact post-merge provider proof completed");
    }
  }

  private async switchToSource(sourceSha: string): Promise<string> {
    const postmerge = sourceSha !== this.plan.headSha;
    const dir = this.checkoutDir
      ?? await this.checkout(postmerge ? this.change.baseBranch : this.args.branch, sourceSha);
    if (this.checkoutSourceSha !== sourceSha) {
      const env = githubGitEnv(this.toolEnv(), this.args.githubToken);
      await this.command("git", ["fetch", "--no-tags", "origin", sourceSha], dir, env);
      await this.command("git", ["checkout", "--detach", sourceSha], dir, this.toolEnv());
      this.checkoutSourceSha = sourceSha;
      this.dependenciesSourceSha = "";
    }
    return dir;
  }

  private async verifyCheckoutStillPinned(sourceSha = this.plan.headSha): Promise<string> {
    const dir = await this.switchToSource(sourceSha);
    const env = this.toolEnv();
    const head = oneLine(await this.command("git", ["rev-parse", "HEAD"], dir, env), 80);
    const shallow = oneLine(await this.command("git", ["rev-parse", "--is-shallow-repository"], dir, env), 20);
    const status = (await this.command("git", ["status", "--porcelain=v1", "--untracked-files=all"], dir, env)).trim();
    await this.verifyRemoteIdentity(sourceSha);
    if (head !== sourceSha || shallow !== "false" || status) {
      throw new Error("the release checkout changed source identity or cleanliness before provider publication");
    }
    return dir;
  }

  private async verifyPinnedBaseIsIncluded(): Promise<void> {
    const dir = await this.verifyCheckoutStillPinned(this.plan.headSha);
    const env = githubGitEnv(this.toolEnv(), this.args.githubToken);
    const known = await this.runCommand("git", ["cat-file", "-e", `${this.plan.baseSha}^{commit}`], {
      cwd: dir,
      env: this.toolEnv(),
      timeoutMs: 30_000,
    });
    if (known.code !== 0) await this.command("git", ["fetch", "--no-tags", "origin", this.plan.baseSha], dir, env);
    const ancestry = await this.runCommand("git", ["merge-base", "--is-ancestor", this.plan.baseSha, this.plan.headSha], {
      cwd: dir,
      env: this.toolEnv(),
      timeoutMs: 30_000,
    });
    if (ancestry.code !== 0) {
      throw new BaseNotIncludedError("the provider candidate does not include the pinned production base");
    }
  }

  private async sourceSnapshot(): Promise<Map<string, string>> {
    const dir = await this.verifyCheckoutStillPinned(this.plan.headSha);
    const listed = await this.command("git", ["ls-files", "-z"], dir, this.toolEnv(), 60_000);
    const sources = new Map<string, string>();
    let totalBytes = 0;
    for (const path of listed.split("\0").filter(Boolean)) {
      const absolute = resolve(dir, path);
      if (!absolute.startsWith(`${resolve(dir)}${sep}`)) throw new Error("a tracked provider source escaped the pinned checkout");
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`tracked provider source ${path} is not a regular file`);
      if (!PARSED_SOURCE_FILE.test(path)) {
        // Asset/config presence is sufficient for import resolution; only
        // executable source needs to enter the bounded parser payload.
        sources.set(path, "");
        continue;
      }
      totalBytes += stat.size;
      if (stat.size > 5 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) {
        throw new Error("the exact provider source graph exceeds the trusted analysis boundary");
      }
      sources.set(path, readFileSync(absolute, "utf8"));
    }
    return sources;
  }

  async preparePlan(): Promise<ProviderReleasePlan> {
    const sources = await this.sourceSnapshot();
    this.plan = buildProviderReleasePlan({
      repository: this.args.repository,
      branch: this.args.branch,
      baseSha: this.change.baseSha,
      headSha: this.change.headSha,
      changedPaths: this.change.changedPaths,
      impact: analyseProviderImpact(this.change.changedPaths, sources),
    });
    if (this.plan.required) {
      await this.verifyPinnedBaseIsIncluded();
      await this.ensureCandidatePreflight();
    }
    return this.plan;
  }

  private async prepareDependencies(sourceSha: string): Promise<string> {
    const dir = await this.verifyCheckoutStillPinned(sourceSha);
    if (this.dependenciesSourceSha === sourceSha) return dir;
    // A release must use the dependency graph committed in the verified head.
    // `npm ci` fails closed on a stale/missing lock instead of rewriting it and
    // silently publishing source that differs from the reviewed branch.
    await installDependenciesInPinnedCheckout({
      sourceSha,
      verifyPinned: (sha) => this.verifyCheckoutStillPinned(sha),
      runNpmCi: async () => {
        const result = await this.candidateCommand({
          command: "npm",
          args: ["ci", "--ignore-scripts"],
          timeoutMs: 20 * 60_000,
        });
        this.candidateOutput(result, "npm ci --ignore-scripts");
      },
    });
    const sandbox = await this.ensureCandidatePreflight();
    await sandbox.verifyPinnedToolchain();
    this.dependenciesSourceSha = sourceSha;
    return dir;
  }

  async persist(state: ProviderReleaseState): Promise<boolean> {
    const path = this.releaseLeaseBegun ? "jobs:updateProviderRelease" : "jobs:beginProviderRelease";
    const result = await this.args.convexMutation(path, {
      jobId: this.args.jobId,
      expectedAttempt: this.args.expectedAttempt,
      release: state,
      leaseToken: this.leaseToken,
    }).catch(() => false);
    const ok = result === true || result?.ok === true;
    if (ok) {
      this.releaseLeaseBegun = true;
      this.currentState = { ...state, steps: state.steps.map((step) => ({ ...step })) };
      this.startHeartbeat();
    }
    return ok;
  }

  private async performOwnershipRenewal(): Promise<boolean> {
    const result = await this.args.convexMutation("jobs:renewProviderReleaseLock", {
      jobId: this.args.jobId,
      expectedAttempt: this.args.expectedAttempt,
      releaseId: this.plan.releaseId,
      baseSha: this.plan.baseSha,
      headSha: this.plan.headSha,
      leaseToken: this.leaseToken,
    }).catch(() => false);
    return result === true || result?.ok === true;
  }

  private async renewOwnership(): Promise<boolean> {
    if (this.heartbeatPromise) return await this.heartbeatPromise;
    const pending = this.performOwnershipRenewal();
    this.heartbeatPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.heartbeatPromise === pending) this.heartbeatPromise = undefined;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const intervalMs = Math.max(5_000, Math.min(120_000, this.args.heartbeatMs ?? 60_000));
    this.heartbeatTimer = setInterval(() => {
      void this.renewOwnership()
        .then((ok) => {
          if (!ok) this.heartbeatFailure = "the trusted repository release lock could not be renewed";
          return ok;
        });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async verifyVercel(step: ProviderReleaseStep): Promise<ProviderStepReceipt> {
    const vercel = this.plan.boundary!.vercel;
    const token = await this.capability(vercel.token);
    const response = await this.fetchImpl(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(vercel.projectName)}?teamId=${encodeURIComponent(vercel.teamId)}`,
      { headers: { authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Vercel project lookup failed with ${response.status}`);
    const project = (await response.json()) as VercelProjectObservation;
    const mismatch = vercelProjectIdentityMismatch(vercel, project);
    if (mismatch) throw new Error(mismatch);
    return verifiedReceipt(step, `Vercel ${project.id} is bound to ${vercel.gitRepository}@${vercel.productionBranch}`, {
      data: { projectId: String(project.id), teamId: vercel.teamId },
    });
  }

  private async verifyVercelLive(step: ProviderReleaseStep, mergeSha: string): Promise<ProviderStepReceipt> {
    const vercel = this.plan.boundary!.vercel;
    const token = await this.capability(vercel.token);
    await this.verifyCheckoutStillPinned(mergeSha);
    const projectReceipt = await this.verifyVercel(
      this.plan.steps.find((candidate) => candidate.kind === "vercel_identity")!,
    );
    const projectId = String(projectReceipt.data?.projectId ?? "");
    if (!projectId) throw new Error("Vercel project identity has no stable project id");
    const headers = { authorization: `Bearer ${token}` };
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await this.continuing();
      const deploymentsResponse = await this.fetchImpl(
        `https://api.vercel.com/v7/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&sha=${encodeURIComponent(mergeSha)}&limit=20&teamId=${encodeURIComponent(vercel.teamId)}`,
        { headers, cache: "no-store" },
      );
      if (!deploymentsResponse.ok) throw new Error(`Vercel deployment lookup failed with ${deploymentsResponse.status}`);
      const payload = await deploymentsResponse.json().catch(() => null) as { deployments?: VercelDeploymentObservation[] } | null;
      for (const deployment of payload?.deployments ?? []) {
        const deploymentId = String(deployment.uid ?? deployment.id ?? "");
        if (!deploymentId) continue;
        const aliasesResponse = await this.fetchImpl(
          `https://api.vercel.com/v2/deployments/${encodeURIComponent(deploymentId)}/aliases?teamId=${encodeURIComponent(vercel.teamId)}`,
          { headers, cache: "no-store" },
        );
        if (!aliasesResponse.ok) continue;
        const aliasesPayload = await aliasesResponse.json().catch(() => null) as { aliases?: Array<{ alias?: string }> } | null;
        const productionAlias = aliasesPayload?.aliases?.find(
          (alias) => String(alias.alias ?? "").toLowerCase() === vercel.productionAlias.toLowerCase(),
        );
        if (!productionAlias) continue;
        const alias: VercelAliasObservation = {
          alias: String(productionAlias.alias),
          deploymentId,
          projectId,
        };
        const mismatch = vercelLiveDeploymentMismatch({
          boundary: vercel,
          expectedProjectId: projectId,
          mergeSha,
          deployment,
          alias,
        });
        if (!mismatch) {
          return verifiedReceipt(step, `Vercel production alias attested exact merged commit ${mergeSha}`, {
            data: { projectId, deploymentId, sourceSha: mergeSha },
          });
        }
      }
      await this.sleep(2_000);
    }
    throw new Error(`Vercel production alias did not attest exact merged commit ${mergeSha}`);
  }

  private async verifyConvexAttestation(
    step: ProviderReleaseStep,
    target: ConvexReleaseTarget,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    const response = await this.fetchImpl(`${target.url.replace(/\/$/, "")}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "_jarvisRelease:attest", args: { releaseId: this.plan.releaseId }, format: "json" }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as any;
    const proof = payload?.value;
    if (
      !response.ok
      || payload?.status === "error"
      || proof?.protocol !== 1
      || proof?.releaseId !== this.plan.releaseId
      || proof?.sourceSha !== sourceSha
      || proof?.deployment !== target.deployment
      || proof?.role !== target.role
    ) {
      throw new Error(`Convex ${target.deployment} returned a missing, mismatched, or stale source attestation`);
    }
    return verifiedReceipt(step, `Convex ${target.deployment} attested ${sourceSha}`, {
      data: { deployment: target.deployment, sourceSha },
    });
  }

  private async proveConvexPremerge(
    step: ProviderReleaseStep,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    if (step.phase !== "premerge") throw new Error("local Convex proof is restricted to the pre-merge phase");
    const target = targetForStep(this.plan, step);
    const dir = await this.prepareDependencies(sourceSha);
    const proofKey = `${sourceSha}\0${target.deployment}`;
    let proof = this.convexProofs.get(proofKey);
    if (!proof) {
      // The deploy key is the sole target selector. It is loaded only after
      // dependency and toolchain preflights have closed, and is exposed only
      // to this target-native dry-run process.
      const deployKey = await this.capability(target.deployKey);
      const keyTarget = deploymentFromConvexKey(deployKey);
      if (keyTarget?.type !== target.deploymentType || keyTarget.deployment !== target.deployment) {
        throw new Error(`Convex dry-run key does not belong to exact ${target.deploymentType}:${target.deployment}`);
      }
      const result = await this.candidateCommand({
        command: "npx",
        args: CONVEX_PREMERGE_PROOF_COMMAND,
        timeoutMs: 20 * 60_000,
        capability: { name: "CONVEX_DEPLOY_KEY", value: deployKey },
      });
      const output = this.candidateOutput(result, "Convex typecheck and bundle dry-run");
      if (!convexPremergeReceiptProvesNoMutation(result)) {
        throw new Error("Convex premerge command receipt did not prove the exact non-mutating dry-run argv");
      }
      const expected = `Would have deployed Convex functions to ${target.url.replace(/\/$/, "")}`;
      if (!output.includes(expected) || /(?:^|\n)\s*Deployed Convex functions to\b/i.test(output)) {
        throw new Error(`Convex dry-run did not attest exact non-mutating target ${target.deployment}`);
      }
      await this.verifyCheckoutStillPinned(sourceSha);
      proof = { commandDigest: result.receipt.commandDigest };
      this.convexProofs.set(proofKey, proof);
    }
    return verifiedReceipt(step, `Convex ${target.deployment} passed exact typecheck and bundle dry-run with zero live mutation`, {
      data: {
        sourceSha,
        deployment: target.deployment,
        localProof: true,
        dryRun: true,
        typecheck: true,
        bundle: true,
        codegen: false,
        liveMutation: false,
        commandDigest: proof.commandDigest,
        candidateSandbox: true,
      },
    });
  }

  private async deployConvex(
    step: ProviderReleaseStep,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    if (step.phase !== "postmerge") throw new Error("live Convex deployment is forbidden before merge");
    const target = targetForStep(this.plan, step);
    const dir = await this.prepareDependencies(sourceSha);
    const deployKey = await this.capability(target.deployKey);
    const keyTarget = deploymentFromConvexKey(deployKey);
    if (keyTarget?.type !== target.deploymentType || keyTarget.deployment !== target.deployment) {
      throw new Error(`Convex deploy key does not belong to exact ${target.deploymentType}:${target.deployment}`);
    }
    const tracked = await this.runCommand("git", ["ls-files", "--error-unmatch", CONVEX_ATTESTOR_FILE], {
      cwd: dir,
      env: this.toolEnv(),
      timeoutMs: 30_000,
    });
    if (tracked.code === 0 || existsSync(join(dir, CONVEX_ATTESTOR_FILE))) {
      throw new Error(`${CONVEX_ATTESTOR_FILE} collides with repository-owned source`);
    }
    writeFileSync(join(dir, CONVEX_ATTESTOR_FILE), attestorSource({ releaseId: this.plan.releaseId, sourceSha, target }), { mode: 0o600 });
    try {
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        proof: `publishing exact source to Convex ${target.deployment}`,
        data: { deployment: target.deployment, sourceSha },
      }))) throw new Error("the Convex deployment checkpoint could not be persisted");
      const result = await this.candidateCommand({
        command: "npx",
        args: ["--no-install", "convex", "deploy", "--yes", "--codegen", "disable", "--message", `JARVIS ${this.plan.releaseId}`],
        timeoutMs: 20 * 60_000,
        capability: { name: "CONVEX_DEPLOY_KEY", value: deployKey },
      });
      this.candidateOutput(result, `Convex ${target.deployment} deployment`);
    } finally {
      rmSync(join(dir, CONVEX_ATTESTOR_FILE), { force: true });
    }
    await this.verifyCheckoutStillPinned(sourceSha);
    return await this.verifyConvexAttestation(step, target, sourceSha);
  }

  private validateTriggerOutput(
    run: any,
    version: string,
    sourceSha: string,
    attestor: GeneratedTriggerAttestor,
  ): { sourceSha: string; version: string } {
    const output = run?.output as any;
    if (
      run?.status !== "COMPLETED"
      || String(run?.version ?? "") !== version
      || output?.protocol !== 1
      || output?.releaseId !== this.plan.releaseId
      || output?.sourceSha !== sourceSha
      || output?.projectRef !== this.plan.boundary?.trigger?.projectRef
      || output?.version !== version
      || output?.taskId !== attestor.taskId
    ) throw new Error(`Trigger run ${String(run?.id ?? "unknown")} did not attest the exact new bundle`);
    return { sourceSha: output.sourceSha, version: output.version };
  }

  private async awaitTriggerRun(
    runId: string,
    version: string,
    sourceSha: string,
    attestor: GeneratedTriggerAttestor,
  ): Promise<any> {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await this.continuing();
      const run = await runs.retrieve(runId);
      if (TERMINAL_TRIGGER_STATUSES.has(String(run.status))) {
        this.validateTriggerOutput(run, version, sourceSha, attestor);
        return run;
      }
      await this.sleep(2_000);
    }
    throw new Error(`Trigger attestation run ${runId} did not finish within the trusted release lease`);
  }

  private async launchTriggerAttestor(
    version: string,
    pinned: boolean,
    sourceSha: string,
    attestor: GeneratedTriggerAttestor,
  ): Promise<string> {
    const handle = await tasks.trigger(
      attestor.taskId,
      {
        protocol: 1,
        releaseId: this.plan.releaseId,
        expectedSourceSha: sourceSha,
        expectedProjectRef: this.plan.boundary!.trigger!.projectRef,
        expectedVersion: version,
      },
      pinned ? { version } : undefined,
    );
    return String(handle.id);
  }

  private async verifyCurrentTrigger(
    step: ProviderReleaseStep,
    version: string,
    sourceSha: string,
    attestor: GeneratedTriggerAttestor,
  ): Promise<ProviderStepReceipt> {
    const runId = await this.launchTriggerAttestor(version, false, sourceSha, attestor);
    await this.awaitTriggerRun(runId, version, sourceSha, attestor);
    return verifiedReceipt(step, `Trigger ${step.target} current version ${version} attested ${sourceSha}`, {
      version,
      runId,
      data: { sourceSha, taskId: attestor.taskId, currentAttested: true },
    });
  }

  private async verifyJarvisSandboxSmoke(version: string): Promise<string> {
    const handle = await tasks.trigger(JARVIS_SANDBOX_SMOKE_TASK, {}, { version });
    const runId = String(handle.id);
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await this.continuing();
      const run = await runs.retrieve(runId);
      if (TERMINAL_TRIGGER_STATUSES.has(String(run.status))) {
        const output = run.output as any;
        if (
          run.status !== "COMPLETED"
          || String(run.version ?? "") !== version
          || output?.protocol !== 1
          || output?.legacyLandlock !== true
          || output?.exactSmoke !== true
          || output?.providerCommandSandbox !== true
        ) throw new Error(`Trigger staged sandbox smoke ${runId} failed closed`);
        return runId;
      }
      await this.sleep(2_000);
    }
    throw new Error(`Trigger staged sandbox smoke ${runId} did not finish within the trusted release lease`);
  }

  private async assertTriggerAttestorCollisionFree(
    dir: string,
    attestor: GeneratedTriggerAttestor,
  ): Promise<void> {
    const taskDirectory = join(dir, "src/trigger");
    const taskStat = lstatSync(taskDirectory);
    if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) {
      throw new Error("target src/trigger must be a non-symlink task directory");
    }
    const file = join(dir, attestor.relativePath);
    const tracked = await this.runCommand("git", ["ls-files", "--error-unmatch", attestor.relativePath], {
      cwd: dir,
      env: this.toolEnv(),
      timeoutMs: 30_000,
    });
    if (tracked.code === 0 || existsSync(file)) throw new Error(`${attestor.relativePath} collides with target source`);
    const idCollision = await this.runCommand("git", ["grep", "-F", "--", attestor.taskId, "--", "src/trigger"], {
      cwd: dir,
      env: this.toolEnv(),
      timeoutMs: 30_000,
    });
    if (idCollision.code === 0) throw new Error(`generated Trigger task id ${attestor.taskId} collides with target source`);
    if (idCollision.code !== 1) throw new Error("target Trigger task ids could not be collision-checked");
  }

  private async deployTrigger(
    step: ProviderReleaseStep,
    prior: ProviderStepReceipt,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    const trigger = this.plan.boundary!.trigger!;
    const dir = await this.prepareDependencies(sourceSha);
    const config = readFileSync(join(dir, "trigger.config.ts"), "utf8");
    if (!config.includes(trigger.projectRef)) {
      throw new Error(`trigger.config.ts does not contain exact project ${trigger.projectRef}`);
    }
    const attestor = generatedTriggerAttestor({
      releaseId: this.plan.releaseId,
      sourceSha,
      projectRef: trigger.projectRef,
    });
    let version = prior.version;
    const priorData = prior.data ?? {};
    if (version && (priorData.sourceSha !== sourceSha || priorData.taskId !== attestor.taskId)) {
      throw new Error("the resumed Trigger version belongs to a different source commit");
    }
    if (!version) {
      await this.verifyCheckoutStillPinned(sourceSha);
      await this.assertTriggerAttestorCollisionFree(dir, attestor);
    }

    // Candidate preflight, npm, pinned CLI checks, config inspection, and
    // collision checks are all complete before either Trigger capability is
    // retrieved. Candidate config can observe its own project access token;
    // this boundary does not claim egress secrecy for that target token.
    let accessToken: string | undefined;
    if (!version) {
      accessToken = await this.capability(trigger.accessToken);
      const generatedPath = join(dir, attestor.relativePath);
      writeFileSync(generatedPath, attestor.source, { mode: 0o600 });
      let output = "";
      try {
        const result = await this.candidateCommand({
          command: "npx",
          args: triggerDeployCommand(trigger.projectRef),
          timeoutMs: 25 * 60_000,
          capability: { name: "TRIGGER_ACCESS_TOKEN", value: accessToken },
        });
        output = this.candidateOutput(result, `Trigger ${trigger.projectRef} staged deploy`);
      } finally {
        rmSync(generatedPath, { force: true });
      }
      await this.verifyCheckoutStillPinned(sourceSha);
      version = output.match(/(?:Successfully deployed version|Version)\s+(\d{8}\.\d+)/i)?.[1];
      if (!version) throw new Error("Trigger deploy completed without an exact deployment version receipt");
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        proof: `Trigger ${trigger.projectRef} staged version ${version} without promotion`,
        data: { sourceSha, taskId: attestor.taskId, staged: true },
      }))) throw new Error("the staged Trigger version could not be persisted");
    }

    // The access-token deploy namespace has emitted CLOSE and the immutable
    // version handoff is durable before the controller retrieves/configures
    // the separate SDK secret used to attest that staged worker.
    const secretKey = await this.capability(trigger.secretKey);
    configure({ accessToken: secretKey });

    let pinnedRunId = typeof priorData.pinnedRunId === "string" ? priorData.pinnedRunId : "";
    if (!priorData.pinnedAttested) {
      if (!pinnedRunId) pinnedRunId = await this.launchTriggerAttestor(version, true, sourceSha, attestor);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new-version attestation ${pinnedRunId} handed to Trigger ${version}`,
        data: { sourceSha, taskId: attestor.taskId, staged: true, pinnedRunId },
      }))) throw new Error("the Trigger handoff run could not be persisted");
      await this.awaitTriggerRun(pinnedRunId, version, sourceSha, attestor);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new worker ${version} independently attested its source bundle`,
        data: { sourceSha, taskId: attestor.taskId, staged: true, pinnedRunId, pinnedAttested: true },
      }))) throw new Error("the Trigger new-worker proof could not be persisted");
    }

    let sandboxRunId = typeof priorData.sandboxRunId === "string" ? priorData.sandboxRunId : "";
    const jarvisTarget = this.plan.repository === "daniels-project-space/jarvis";
    if (jarvisTarget && !priorData.sandboxAttested) {
      sandboxRunId = await this.verifyJarvisSandboxSmoke(version);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `staged Jarvis worker ${version} passed the exact specialist sandbox smoke`,
        data: {
          sourceSha,
          taskId: attestor.taskId,
          staged: true,
          pinnedRunId,
          pinnedAttested: true,
          sandboxRunId,
          sandboxAttested: true,
        },
      }))) throw new Error("the staged Jarvis sandbox proof could not be persisted");
    }

    accessToken ??= await this.capability(trigger.accessToken);
    const promoteResult = await this.candidateCommand({
      command: "npx",
      args: triggerPromoteCommand(trigger.projectRef, version),
      timeoutMs: 10 * 60_000,
      capability: { name: "TRIGGER_ACCESS_TOKEN", value: accessToken },
    });
    this.candidateOutput(promoteResult, `Trigger ${trigger.projectRef} promotion`);
    if (!(await checkpoint({
      id: step.id,
      status: "deploying",
      version,
      runId: pinnedRunId,
      proof: `Trigger ${trigger.projectRef} promoted independently-attested ${version}`,
      data: {
        sourceSha,
        taskId: attestor.taskId,
        pinnedRunId,
        pinnedAttested: true,
        ...(jarvisTarget ? { sandboxRunId, sandboxAttested: true } : {}),
        promoted: true,
      },
    }))) throw new Error("the Trigger promotion checkpoint could not be persisted");
    return await this.verifyCurrentTrigger(step, version, sourceSha, attestor);
  }

  async execute(
    step: ProviderReleaseStep,
    prior: ProviderStepReceipt,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
    state: ProviderReleaseState,
  ): Promise<ProviderStepReceipt> {
    await this.continuing();
    const sourceSha = step.phase === "postmerge" ? String(state.mergeSha ?? "") : this.plan.headSha;
    if (!/^[0-9a-f]{40,64}$/i.test(sourceSha)) throw new Error("provider step has no exact source commit");
    if (step.kind === "vercel_identity") return await this.verifyVercel(step);
    if (step.kind === "vercel_live") return await this.verifyVercelLive(step, sourceSha);
    if (step.kind === "convex") {
      return convexReleaseAction(step.phase) === "local-proof"
        ? await this.proveConvexPremerge(step, sourceSha)
        : await this.deployConvex(step, checkpoint, sourceSha);
    }
    return await this.deployTrigger(step, prior, checkpoint, sourceSha);
  }

  async reverify(step: ProviderReleaseStep, prior: ProviderStepReceipt, state: ProviderReleaseState): Promise<ProviderStepReceipt> {
    await this.continuing();
    const sourceSha = step.phase === "postmerge" ? String(state.mergeSha ?? "") : this.plan.headSha;
    if (step.kind === "vercel_identity") return await this.verifyVercel(step);
    if (step.kind === "vercel_live") return await this.verifyVercelLive(step, sourceSha);
    if (step.kind === "convex") {
      return convexReleaseAction(step.phase) === "local-proof"
        ? await this.proveConvexPremerge(step, sourceSha)
        : await this.verifyConvexAttestation(step, targetForStep(this.plan, step), sourceSha);
    }
    if (!prior.version) throw new Error("the Trigger receipt has no deployment version");
    const secretKey = await this.capability(this.plan.boundary!.trigger!.secretKey);
    configure({ accessToken: secretKey });
    const attestor = generatedTriggerAttestor({
      releaseId: this.plan.releaseId,
      sourceSha,
      projectRef: this.plan.boundary!.trigger!.projectRef,
    });
    if (prior.data?.taskId !== attestor.taskId) throw new Error("the Trigger receipt names a different generated attestor");
    return await this.verifyCurrentTrigger(step, prior.version, sourceSha, attestor);
  }

  private operations() {
    return {
      persist: (state: ProviderReleaseState) => this.persist(state),
      execute: ({ step, prior, checkpoint, state }: {
        step: ProviderReleaseStep;
        prior: ProviderStepReceipt;
        checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>;
        state: ProviderReleaseState;
      }) => this.execute(step, prior, checkpoint, state),
      reverify: ({ step, prior, state }: {
        step: ProviderReleaseStep;
        prior: ProviderStepReceipt;
        state: ProviderReleaseState;
      }) => this.reverify(step, prior, state),
    };
  }

  setPriorState(prior: ProviderReleaseState): void {
    this.currentState = { ...prior, steps: prior.steps.map((step) => ({ ...step })) };
  }

  async runPremerge(prior: ProviderReleaseState | undefined): Promise<ProviderBarrierResult> {
    const result = await runProviderReleaseBarrier(this.plan, prior, this.operations());
    if (result.status === "ready") this.currentState = result.state;
    return result;
  }

  async confirmMerge(change: PullRequestChange): Promise<
    { status: "ready"; note: string } | { status: "blocked" | "pending"; note: string }
  > {
    if (
      change.headSha !== this.plan.headSha
      || change.baseSha !== this.plan.baseSha
      || change.headBranch !== this.plan.branch
      || change.baseBranch !== this.plan.boundary?.vercel.productionBranch
    ) return { status: "pending", note: "the exact pull request candidate changed before merge ownership confirmation" };
    try {
      await this.verifyCheckoutStillPinned(this.plan.headSha);
      await this.verifyPinnedBaseIsIncluded();
      const result = await this.runPremerge(this.currentState);
      if (result.status !== "ready") return { status: "blocked", note: result.note };
      if (!(await this.renewOwnership())) {
        return { status: "blocked", note: "the trusted repository release lock is no longer owned immediately before merge" };
      }
      return { status: "ready", note: "exact provider evidence, base identity and release-lock ownership rechecked" };
    } catch (error) {
      return { status: "blocked", note: String(error instanceof Error ? error.message : error).slice(0, 500) };
    }
  }

  async proveLive(mergeSha: string): Promise<
    { status: "live"; note: string } | { status: "blocked" | "pending"; note: string }
  > {
    if (!this.currentState) return { status: "blocked", note: "the durable pre-merge provider state is missing" };
    try {
      const result: ProviderLiveBarrierResult = await runPostMergeReleaseBarrier(
        this.plan,
        this.currentState,
        mergeSha,
        this.operations(),
      );
      this.currentState = result.state;
      if (result.status !== "live") return { status: "blocked", note: result.note };
      if (!(await this.renewOwnership())) {
        return { status: "blocked", note: "the trusted repository release lock is no longer owned before finalization" };
      }
      const finalized = await this.args.convexMutation("jobs:finalizeProviderDelivery", {
        jobId: this.args.jobId,
        expectedAttempt: this.args.expectedAttempt,
        releaseId: this.plan.releaseId,
        baseSha: this.plan.baseSha,
        headSha: this.plan.headSha,
        mergeSha,
        leaseToken: this.leaseToken,
      }).catch(() => false);
      if (!(finalized === true || finalized?.ok === true)) {
        return { status: "blocked", note: "exact live proofs passed, but atomic provider delivery finalization was rejected" };
      }
      return { status: "live", note: result.note };
    } catch (error) {
      return { status: "blocked", note: String(error instanceof Error ? error.message : error).slice(0, 500) };
    }
  }
}

export function createTrustedProviderReleaseGate(
  args: TrustedProviderReleaseGateArgs,
): (change: PullRequestChange) => Promise<ProviderMergeGate> {
  return async (change) => {
    const provisionalPlan = buildProviderReleasePlan({
      repository: args.repository,
      branch: args.branch,
      baseSha: change.baseSha,
      headSha: change.headSha,
      changedPaths: change.changedPaths,
    });
    const runtime = new TrustedProviderReleaseRuntime(args, change, provisionalPlan);
    try {
      const plan = await runtime.preparePlan();
      if (!plan.required) {
        await runtime.cleanup();
        return { status: "not_required", note: plan.note };
      }
      if (
        change.headBranch !== args.branch
        || change.baseBranch !== plan.boundary?.vercel.productionBranch
      ) {
        await runtime.cleanup();
        return { status: "blocked", note: "pull request branches do not match the exact registered production route" };
      }
      const result = await runtime.runPremerge(args.prior);
      if (result.status === "ready") {
        return {
          status: "ready",
          note: result.note,
          headSha: result.headSha,
          baseSha: result.baseSha,
          controller: {
            confirmMerge: (candidate) => runtime.confirmMerge(candidate),
            proveLive: (mergeSha) => runtime.proveLive(mergeSha),
            cleanup: () => runtime.cleanup(),
          },
        };
      }
      await runtime.cleanup();
      if (result.status === "not_required") return result;
      return { status: "blocked", note: result.note };
    } catch (error) {
      await runtime.cleanup();
      if (error instanceof BaseNotIncludedError) {
        return { status: "pending", refreshBase: true, note: error.message };
      }
      return {
        status: "blocked",
        note: `trusted provider planning failed: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
      };
    }
  };
}

export async function resumeTrustedProviderPostMerge(
  args: TrustedProviderReleaseGateArgs & { prior: ProviderReleaseState },
): Promise<{ status: "live"; note: string } | { status: "blocked" | "pending"; note: string }> {
  const prior = args.prior;
  if (!prior.mergeSha) return { status: "blocked", note: "the resumed provider release has no exact merge commit" };
  const plan = buildProviderReleasePlan({
    repository: args.repository,
    branch: args.branch,
    baseSha: prior.baseSha,
    headSha: prior.headSha,
    changedPaths: prior.changedPaths,
    impact: {
      providers: prior.providers,
      reasons: { convex: [], trigger: [] },
      digest: prior.impactDigest,
    },
  });
  if (
    !plan.required
    || !plan.valid
    || plan.releaseId !== prior.releaseId
    || plan.boundaryDigest !== prior.boundaryDigest
  ) return { status: "blocked", note: "the resumed provider release no longer matches the trusted source or boundary" };
  const runtime = new TrustedProviderReleaseRuntime(args, {
    baseSha: prior.baseSha,
    headSha: prior.headSha,
    baseBranch: plan.boundary!.vercel.productionBranch,
    headBranch: prior.branch,
    changedPaths: prior.changedPaths,
  }, plan);
  runtime.setPriorState(prior);
  try {
    return await runtime.proveLive(prior.mergeSha);
  } finally {
    await runtime.cleanup();
  }
}
