import { configure, runs, tasks } from "@trigger.dev/sdk/v3";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
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
  TrustedProviderBoundary,
} from "../lib/project-registry";
import { githubGitEnv, githubRepoUrl } from "./git-transport";
import type { ProviderMergeGate, PullRequestChange } from "./github-delivery";
import { vaultService } from "../lib/vault-client";

type ConvexMutation = (path: string, args: unknown) => Promise<any>;
type CommandResult = { code: number | null; out: string };
type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CommandResult>;

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

const RELEASE_ATTESTOR_TASK = "jarvis-provider-release-attestor";
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

function oneLine(value: string, limit = 500): string {
  return value.trim().replace(/\s+/g, " ").slice(-limit);
}

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const outputLimit = command === "git" && args[0] === "ls-files" ? 10 * 1024 * 1024 : 30_000;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, options.timeoutMs);
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-outputLimit);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${output}\n${String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: output });
    });
  });
}

function safeToolEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CI",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
  ]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  env.PATH = base.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

function triggerDeployEnv(
  base: NodeJS.ProcessEnv,
  boundary: TrustedProviderBoundary,
  accessToken: string,
  headSha: string,
): NodeJS.ProcessEnv {
  // This command is the trusted controller, not the Codex specialist. Existing
  // Trigger worker capabilities must remain available to trigger.config's
  // explicit sync allowlist when it builds the replacement bundle.
  return {
    ...base,
    TRIGGER_ACCESS_TOKEN: accessToken,
    TRIGGER_PROJECT_REF_JARVIS: boundary.trigger!.projectRef,
    JARVIS_RELEASE_SOURCE_SHA: headSha,
  };
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
  private readonly leaseToken = randomBytes(24).toString("hex");
  private readonly services = new Map<string, Promise<Record<string, string>>>();
  private checkoutDir: string | null = null;
  private checkoutSourceSha = "";
  private dependenciesSourceSha = "";
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
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeatPromise?.catch(() => false);
    if (this.checkoutDir) rmSync(resolve(this.checkoutDir, ".."), { recursive: true, force: true });
    this.checkoutDir = null;
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

  private async capability(reference: ReleaseCapabilityRef): Promise<string> {
    const fromEnv = reference.env ? this.args.baseEnv[reference.env] : undefined;
    if (fromEnv?.trim()) return fromEnv.trim();
    const values = await this.service(reference.service).catch(() => ({} as Record<string, string>));
    const value = values[reference.key]?.trim();
    if (!value) throw new Error(`trusted release capability ${reference.service}.${reference.key} is unavailable`);
    return value;
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
    const gitEnv = githubGitEnv(safeToolEnv(this.args.baseEnv), this.args.githubToken);
    try {
      await this.command(
        "git",
        ["clone", "--no-tags", "--single-branch", "--branch", initialBranch, githubRepoUrl(this.args.repository), dir],
        root,
        gitEnv,
      );
      await this.command("git", ["remote", "set-url", "origin", githubRepoUrl(this.args.repository)], dir, safeToolEnv(this.args.baseEnv));
      const head = oneLine(await this.command("git", ["rev-parse", "HEAD"], dir, safeToolEnv(this.args.baseEnv)), 80);
      const branch = oneLine(await this.command("git", ["branch", "--show-current"], dir, safeToolEnv(this.args.baseEnv)), 240);
      const shallow = oneLine(await this.command("git", ["rev-parse", "--is-shallow-repository"], dir, safeToolEnv(this.args.baseEnv)), 20);
      const status = (await this.command("git", ["status", "--porcelain=v1", "--untracked-files=all"], dir, safeToolEnv(this.args.baseEnv))).trim();
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
    const env = safeToolEnv(this.args.baseEnv);
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
      const env = githubGitEnv(safeToolEnv(this.args.baseEnv), this.args.githubToken);
      await this.command("git", ["fetch", "--no-tags", "origin", sourceSha], dir, env);
      await this.command("git", ["checkout", "--detach", sourceSha], dir, safeToolEnv(this.args.baseEnv));
      this.checkoutSourceSha = sourceSha;
      this.dependenciesSourceSha = "";
    }
    return dir;
  }

  private async verifyCheckoutStillPinned(sourceSha = this.plan.headSha): Promise<string> {
    const dir = await this.switchToSource(sourceSha);
    const env = safeToolEnv(this.args.baseEnv);
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
    const env = githubGitEnv(safeToolEnv(this.args.baseEnv), this.args.githubToken);
    const known = await this.runCommand("git", ["cat-file", "-e", `${this.plan.baseSha}^{commit}`], {
      cwd: dir,
      env: safeToolEnv(this.args.baseEnv),
      timeoutMs: 30_000,
    });
    if (known.code !== 0) await this.command("git", ["fetch", "--no-tags", "origin", this.plan.baseSha], dir, env);
    const ancestry = await this.runCommand("git", ["merge-base", "--is-ancestor", this.plan.baseSha, this.plan.headSha], {
      cwd: dir,
      env: safeToolEnv(this.args.baseEnv),
      timeoutMs: 30_000,
    });
    if (ancestry.code !== 0) {
      throw new BaseNotIncludedError("the provider candidate does not include the pinned production base");
    }
  }

  private async sourceSnapshot(): Promise<Map<string, string>> {
    const dir = await this.verifyCheckoutStillPinned(this.plan.headSha);
    const listed = await this.command("git", ["ls-files", "-z"], dir, safeToolEnv(this.args.baseEnv), 60_000);
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
    if (this.plan.required) await this.verifyPinnedBaseIsIncluded();
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
      runNpmCi: async (cwd) => {
        await this.command("npm", ["ci"], cwd, safeToolEnv(this.args.baseEnv), 20 * 60_000);
      },
    });
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

  private async deployConvex(
    step: ProviderReleaseStep,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    const target = targetForStep(this.plan, step);
    const deployKey = await this.capability(target.deployKey);
    const keyTarget = deploymentFromConvexKey(deployKey);
    if (keyTarget?.type !== target.deploymentType || keyTarget.deployment !== target.deployment) {
      throw new Error(`Convex deploy key does not belong to exact ${target.deploymentType}:${target.deployment}`);
    }
    const dir = await this.prepareDependencies(sourceSha);
    const tracked = await this.runCommand("git", ["ls-files", "--error-unmatch", CONVEX_ATTESTOR_FILE], {
      cwd: dir,
      env: safeToolEnv(this.args.baseEnv),
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
      await this.command(
        "npx",
        ["convex", "deploy", "--yes", "--codegen", "disable", "--message", `JARVIS ${this.plan.releaseId}`],
        dir,
        { ...safeToolEnv(this.args.baseEnv), CONVEX_DEPLOY_KEY: deployKey },
        20 * 60_000,
      );
      return await this.verifyConvexAttestation(step, target, sourceSha);
    } finally {
      rmSync(join(dir, CONVEX_ATTESTOR_FILE), { force: true });
    }
  }

  private validateTriggerOutput(run: any, version: string, sourceSha: string): { sourceSha: string; version: string } {
    const output = run?.output as any;
    if (
      run?.status !== "COMPLETED"
      || String(run?.version ?? "") !== version
      || output?.protocol !== 1
      || output?.releaseId !== this.plan.releaseId
      || output?.sourceSha !== sourceSha
      || output?.projectRef !== this.plan.boundary?.trigger?.projectRef
      || output?.version !== version
      || output?.sandboxSmoke !== true
    ) throw new Error(`Trigger run ${String(run?.id ?? "unknown")} did not attest the exact new bundle`);
    return { sourceSha: output.sourceSha, version: output.version };
  }

  private async awaitTriggerRun(runId: string, version: string, sourceSha: string): Promise<any> {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await this.continuing();
      const run = await runs.retrieve(runId);
      if (TERMINAL_TRIGGER_STATUSES.has(String(run.status))) {
        this.validateTriggerOutput(run, version, sourceSha);
        return run;
      }
      await this.sleep(2_000);
    }
    throw new Error(`Trigger attestation run ${runId} did not finish within the trusted release lease`);
  }

  private async launchTriggerAttestor(version: string, pinned: boolean, sourceSha: string): Promise<string> {
    const handle = await tasks.trigger(
      RELEASE_ATTESTOR_TASK,
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
  ): Promise<ProviderStepReceipt> {
    const runId = await this.launchTriggerAttestor(version, false, sourceSha);
    await this.awaitTriggerRun(runId, version, sourceSha);
    return verifiedReceipt(step, `Trigger ${step.target} current version ${version} attested ${sourceSha}`, {
      version,
      runId,
      data: { sourceSha, currentAttested: true },
    });
  }

  private async deployTrigger(
    step: ProviderReleaseStep,
    prior: ProviderStepReceipt,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
    sourceSha: string,
  ): Promise<ProviderStepReceipt> {
    const trigger = this.plan.boundary!.trigger!;
    const [accessToken, secretKey] = await Promise.all([
      this.capability(trigger.accessToken),
      this.capability(trigger.secretKey),
    ]);
    configure({ accessToken: secretKey });
    const dir = await this.prepareDependencies(sourceSha);
    const config = readFileSync(join(dir, "trigger.config.ts"), "utf8");
    if (!config.includes(trigger.projectRef)) {
      throw new Error(`trigger.config.ts does not contain exact project ${trigger.projectRef}`);
    }
    let version = prior.version;
    const priorData = prior.data ?? {};
    if (version && priorData.sourceSha !== sourceSha) {
      throw new Error("the resumed Trigger version belongs to a different source commit");
    }
    if (!version) {
      const output = await this.command(
        "npx",
        ["trigger.dev", "deploy", "--skip-promotion"],
        dir,
        triggerDeployEnv(this.args.baseEnv, this.plan.boundary!, accessToken, sourceSha),
        25 * 60_000,
      );
      version = output.match(/(?:Successfully deployed version|Version)\s+(\d{8}\.\d+)/i)?.[1];
      if (!version) throw new Error("Trigger deploy completed without an exact deployment version receipt");
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        proof: `Trigger ${trigger.projectRef} staged version ${version} without promotion`,
        data: { sourceSha, staged: true },
      }))) throw new Error("the staged Trigger version could not be persisted");
    }

    let pinnedRunId = typeof priorData.pinnedRunId === "string" ? priorData.pinnedRunId : "";
    if (!priorData.pinnedAttested) {
      if (!pinnedRunId) pinnedRunId = await this.launchTriggerAttestor(version, true, sourceSha);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new-version attestation ${pinnedRunId} handed to Trigger ${version}`,
        data: { sourceSha, staged: true, pinnedRunId },
      }))) throw new Error("the Trigger handoff run could not be persisted");
      await this.awaitTriggerRun(pinnedRunId, version, sourceSha);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new worker ${version} independently attested its source bundle`,
        data: { sourceSha, staged: true, pinnedRunId, pinnedAttested: true },
      }))) throw new Error("the Trigger new-worker proof could not be persisted");
    }

    await this.command(
      "npx",
      ["trigger.dev", "promote", version],
      dir,
      triggerDeployEnv(this.args.baseEnv, this.plan.boundary!, accessToken, sourceSha),
      10 * 60_000,
    );
    if (!(await checkpoint({
      id: step.id,
      status: "deploying",
      version,
      runId: pinnedRunId,
      proof: `Trigger ${trigger.projectRef} promoted independently-attested ${version}`,
      data: { sourceSha, pinnedRunId, pinnedAttested: true, promoted: true },
    }))) throw new Error("the Trigger promotion checkpoint could not be persisted");
    return await this.verifyCurrentTrigger(step, version, sourceSha);
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
    if (step.kind === "convex") return await this.deployConvex(step, checkpoint, sourceSha);
    return await this.deployTrigger(step, prior, checkpoint, sourceSha);
  }

  async reverify(step: ProviderReleaseStep, prior: ProviderStepReceipt, state: ProviderReleaseState): Promise<ProviderStepReceipt> {
    await this.continuing();
    const sourceSha = step.phase === "postmerge" ? String(state.mergeSha ?? "") : this.plan.headSha;
    if (step.kind === "vercel_identity") return await this.verifyVercel(step);
    if (step.kind === "vercel_live") return await this.verifyVercelLive(step, sourceSha);
    if (step.kind === "convex") return await this.verifyConvexAttestation(step, targetForStep(this.plan, step), sourceSha);
    if (!prior.version) throw new Error("the Trigger receipt has no deployment version");
    const secretKey = await this.capability(this.plan.boundary!.trigger!.secretKey);
    configure({ accessToken: secretKey });
    return await this.verifyCurrentTrigger(step, prior.version, sourceSha);
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
