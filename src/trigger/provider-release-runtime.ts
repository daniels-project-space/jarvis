import { configure, runs, tasks } from "@trigger.dev/sdk/v3";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderReleasePlan,
  runProviderReleaseBarrier,
  vercelProjectIdentityMismatch,
  type ProviderBarrierResult,
  type ProviderReleasePlan,
  type ProviderReleaseState,
  type ProviderReleaseStep,
  type ProviderStepReceipt,
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

type TrustedProviderReleaseGateArgs = {
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
};

const RELEASE_ATTESTOR_TASK = "jarvis-provider-release-attestor";
const CONVEX_ATTESTOR_FILE = "convex/_jarvisRelease.ts";
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
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, options.timeoutMs);
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-30_000);
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
  headSha: string;
  target: ConvexReleaseTarget;
}): string {
  return `import { query } from "./_generated/server";\nimport { v } from "convex/values";\n\n` +
    `const RECEIPT = Object.freeze(${JSON.stringify({
      protocol: 1,
      releaseId: args.releaseId,
      sourceSha: args.headSha,
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

class TrustedProviderReleaseRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly runCommand: CommandRunner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leaseToken = randomBytes(24).toString("hex");
  private readonly services = new Map<string, Promise<Record<string, string>>>();
  private checkoutDir: string | null = null;
  private dependenciesReady = false;
  private releaseLeaseBegun = false;

  constructor(
    private readonly args: TrustedProviderReleaseGateArgs,
    private readonly change: PullRequestChange,
    private readonly plan: ProviderReleasePlan,
  ) {
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.runCommand = args.runCommand ?? defaultCommandRunner;
    this.sleep = args.sleep ?? delay;
  }

  async cleanup(): Promise<void> {
    if (!this.checkoutDir) return;
    rmSync(this.checkoutDir, { recursive: true, force: true });
    this.checkoutDir = null;
  }

  private async continuing(): Promise<void> {
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
    return result.out;
  }

  private async checkout(): Promise<string> {
    if (this.checkoutDir) return this.checkoutDir;
    const root = mkdtempSync(join(tmpdir(), "jarvis-provider-release-"));
    const dir = join(root, "repository");
    const gitEnv = githubGitEnv(safeToolEnv(this.args.baseEnv), this.args.githubToken);
    try {
      await this.command(
        "git",
        ["clone", "--depth", "1", "--single-branch", "--branch", this.args.branch, githubRepoUrl(this.args.repository), dir],
        root,
        gitEnv,
      );
      await this.command("git", ["remote", "set-url", "origin", githubRepoUrl(this.args.repository)], dir, safeToolEnv(this.args.baseEnv));
      const head = oneLine(await this.command("git", ["rev-parse", "HEAD"], dir, safeToolEnv(this.args.baseEnv)), 80);
      const branch = oneLine(await this.command("git", ["branch", "--show-current"], dir, safeToolEnv(this.args.baseEnv)), 240);
      const status = (await this.command("git", ["status", "--porcelain=v1", "--untracked-files=all"], dir, safeToolEnv(this.args.baseEnv))).trim();
      if (head !== this.plan.headSha || branch !== this.args.branch || status) {
        throw new Error("the trusted provider checkout does not match the exact clean verified branch head");
      }
      this.checkoutDir = dir;
      return dir;
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async verifyCheckoutStillPinned(): Promise<string> {
    const dir = await this.checkout();
    const env = safeToolEnv(this.args.baseEnv);
    const head = oneLine(await this.command("git", ["rev-parse", "HEAD"], dir, env), 80);
    const status = (await this.command("git", ["status", "--porcelain=v1", "--untracked-files=all"], dir, env)).trim();
    const remote = oneLine(await this.command(
      "git",
      ["ls-remote", githubRepoUrl(this.args.repository), `refs/heads/${this.args.branch}`],
      dir,
      githubGitEnv(env, this.args.githubToken),
    ), 500).split(/\s+/)[0] ?? "";
    if (head !== this.plan.headSha || remote !== this.plan.headSha || status) {
      throw new Error("the verified branch changed or the release checkout became dirty before provider publication");
    }
    return dir;
  }

  private async prepareDependencies(): Promise<string> {
    const dir = await this.verifyCheckoutStillPinned();
    if (this.dependenciesReady) return dir;
    // A release must use the dependency graph committed in the verified head.
    // `npm ci` fails closed on a stale/missing lock instead of rewriting it and
    // silently publishing source that differs from the reviewed branch.
    await this.command("npm", ["ci"], dir, safeToolEnv(this.args.baseEnv), 20 * 60_000);
    await this.verifyCheckoutStillPinned();
    this.dependenciesReady = true;
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
    if (ok) this.releaseLeaseBegun = true;
    return ok;
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

  private async verifyConvexAttestation(
    step: ProviderReleaseStep,
    target: ConvexReleaseTarget,
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
      || proof?.sourceSha !== this.plan.headSha
      || proof?.deployment !== target.deployment
      || proof?.role !== target.role
    ) {
      throw new Error(`Convex ${target.deployment} returned a missing, mismatched, or stale source attestation`);
    }
    return verifiedReceipt(step, `Convex ${target.deployment} attested ${this.plan.headSha}`);
  }

  private async deployConvex(
    step: ProviderReleaseStep,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
  ): Promise<ProviderStepReceipt> {
    const target = targetForStep(this.plan, step);
    const deployKey = await this.capability(target.deployKey);
    const keyTarget = deploymentFromConvexKey(deployKey);
    if (keyTarget?.type !== target.deploymentType || keyTarget.deployment !== target.deployment) {
      throw new Error(`Convex deploy key does not belong to exact ${target.deploymentType}:${target.deployment}`);
    }
    const dir = await this.prepareDependencies();
    const tracked = await this.runCommand("git", ["ls-files", "--error-unmatch", CONVEX_ATTESTOR_FILE], {
      cwd: dir,
      env: safeToolEnv(this.args.baseEnv),
      timeoutMs: 30_000,
    });
    if (tracked.code === 0 || existsSync(join(dir, CONVEX_ATTESTOR_FILE))) {
      throw new Error(`${CONVEX_ATTESTOR_FILE} collides with repository-owned source`);
    }
    writeFileSync(join(dir, CONVEX_ATTESTOR_FILE), attestorSource({ releaseId: this.plan.releaseId, headSha: this.plan.headSha, target }), { mode: 0o600 });
    try {
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        proof: `publishing exact source to Convex ${target.deployment}`,
        data: { deployment: target.deployment, sourceSha: this.plan.headSha },
      }))) throw new Error("the Convex deployment checkpoint could not be persisted");
      await this.command(
        "npx",
        ["convex", "deploy", "--yes", "--codegen", "disable", "--message", `JARVIS ${this.plan.releaseId}`],
        dir,
        { ...safeToolEnv(this.args.baseEnv), CONVEX_DEPLOY_KEY: deployKey },
        20 * 60_000,
      );
      return await this.verifyConvexAttestation(step, target);
    } finally {
      rmSync(join(dir, CONVEX_ATTESTOR_FILE), { force: true });
    }
  }

  private validateTriggerOutput(run: any, version: string): { sourceSha: string; version: string } {
    const output = run?.output as any;
    if (
      run?.status !== "COMPLETED"
      || String(run?.version ?? "") !== version
      || output?.protocol !== 1
      || output?.releaseId !== this.plan.releaseId
      || output?.sourceSha !== this.plan.headSha
      || output?.projectRef !== this.plan.boundary?.trigger?.projectRef
      || output?.version !== version
    ) throw new Error(`Trigger run ${String(run?.id ?? "unknown")} did not attest the exact new bundle`);
    return { sourceSha: output.sourceSha, version: output.version };
  }

  private async awaitTriggerRun(runId: string, version: string): Promise<any> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await this.continuing();
      const run = await runs.retrieve(runId);
      if (TERMINAL_TRIGGER_STATUSES.has(String(run.status))) {
        this.validateTriggerOutput(run, version);
        return run;
      }
      await this.sleep(2_000);
    }
    throw new Error(`Trigger attestation run ${runId} did not finish within the trusted release lease`);
  }

  private async launchTriggerAttestor(version: string, pinned: boolean): Promise<string> {
    const handle = await tasks.trigger(
      RELEASE_ATTESTOR_TASK,
      {
        protocol: 1,
        releaseId: this.plan.releaseId,
        expectedSourceSha: this.plan.headSha,
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
  ): Promise<ProviderStepReceipt> {
    const runId = await this.launchTriggerAttestor(version, false);
    await this.awaitTriggerRun(runId, version);
    return verifiedReceipt(step, `Trigger ${step.target} current version ${version} attested ${this.plan.headSha}`, {
      version,
      runId,
      data: { sourceSha: this.plan.headSha, currentAttested: true },
    });
  }

  private async deployTrigger(
    step: ProviderReleaseStep,
    prior: ProviderStepReceipt,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
  ): Promise<ProviderStepReceipt> {
    const trigger = this.plan.boundary!.trigger!;
    const [accessToken, secretKey] = await Promise.all([
      this.capability(trigger.accessToken),
      this.capability(trigger.secretKey),
    ]);
    configure({ accessToken: secretKey });
    const dir = await this.prepareDependencies();
    const config = readFileSync(join(dir, "trigger.config.ts"), "utf8");
    if (!config.includes(trigger.projectRef)) {
      throw new Error(`trigger.config.ts does not contain exact project ${trigger.projectRef}`);
    }
    let version = prior.version;
    const priorData = prior.data ?? {};
    if (!version) {
      const output = await this.command(
        "npx",
        ["trigger.dev", "deploy", "--skip-promotion"],
        dir,
        triggerDeployEnv(this.args.baseEnv, this.plan.boundary!, accessToken, this.plan.headSha),
        25 * 60_000,
      );
      version = output.match(/(?:Successfully deployed version|Version)\s+(\d{8}\.\d+)/i)?.[1];
      if (!version) throw new Error("Trigger deploy completed without an exact deployment version receipt");
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        proof: `Trigger ${trigger.projectRef} staged version ${version} without promotion`,
        data: { sourceSha: this.plan.headSha, staged: true },
      }))) throw new Error("the staged Trigger version could not be persisted");
    }

    let pinnedRunId = typeof priorData.pinnedRunId === "string" ? priorData.pinnedRunId : "";
    if (!priorData.pinnedAttested) {
      if (!pinnedRunId) pinnedRunId = await this.launchTriggerAttestor(version, true);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new-version attestation ${pinnedRunId} handed to Trigger ${version}`,
        data: { sourceSha: this.plan.headSha, staged: true, pinnedRunId },
      }))) throw new Error("the Trigger handoff run could not be persisted");
      await this.awaitTriggerRun(pinnedRunId, version);
      if (!(await checkpoint({
        id: step.id,
        status: "deploying",
        version,
        runId: pinnedRunId,
        proof: `new worker ${version} independently attested its source bundle`,
        data: { sourceSha: this.plan.headSha, staged: true, pinnedRunId, pinnedAttested: true },
      }))) throw new Error("the Trigger new-worker proof could not be persisted");
    }

    await this.command(
      "npx",
      ["trigger.dev", "promote", version],
      dir,
      triggerDeployEnv(this.args.baseEnv, this.plan.boundary!, accessToken, this.plan.headSha),
      10 * 60_000,
    );
    if (!(await checkpoint({
      id: step.id,
      status: "deploying",
      version,
      runId: pinnedRunId,
      proof: `Trigger ${trigger.projectRef} promoted independently-attested ${version}`,
      data: { sourceSha: this.plan.headSha, pinnedRunId, pinnedAttested: true, promoted: true },
    }))) throw new Error("the Trigger promotion checkpoint could not be persisted");
    return await this.verifyCurrentTrigger(step, version);
  }

  async execute(
    step: ProviderReleaseStep,
    prior: ProviderStepReceipt,
    checkpoint: (receipt: ProviderStepReceipt) => Promise<boolean>,
  ): Promise<ProviderStepReceipt> {
    await this.continuing();
    if (step.kind === "vercel_identity") return await this.verifyVercel(step);
    if (step.kind === "convex") return await this.deployConvex(step, checkpoint);
    return await this.deployTrigger(step, prior, checkpoint);
  }

  async reverify(step: ProviderReleaseStep, prior: ProviderStepReceipt): Promise<ProviderStepReceipt> {
    await this.continuing();
    if (step.kind === "vercel_identity") return await this.verifyVercel(step);
    if (step.kind === "convex") return await this.verifyConvexAttestation(step, targetForStep(this.plan, step));
    if (!prior.version) throw new Error("the Trigger receipt has no deployment version");
    const secretKey = await this.capability(this.plan.boundary!.trigger!.secretKey);
    configure({ accessToken: secretKey });
    return await this.verifyCurrentTrigger(step, prior.version);
  }
}

export function createTrustedProviderReleaseGate(
  args: TrustedProviderReleaseGateArgs,
): (change: PullRequestChange) => Promise<ProviderMergeGate> {
  return async (change) => {
    const plan = buildProviderReleasePlan({
      repository: args.repository,
      branch: args.branch,
      baseSha: change.baseSha,
      headSha: change.headSha,
      changedPaths: change.changedPaths,
    });
    if (!plan.required) return { status: "not_required", note: plan.note };
    if (
      change.headBranch !== args.branch
      || change.baseBranch !== plan.boundary?.vercel.productionBranch
    ) {
      return { status: "blocked", note: "pull request branches do not match the exact registered production route" };
    }
    const runtime = new TrustedProviderReleaseRuntime(args, change, plan);
    try {
      const result: ProviderBarrierResult = await runProviderReleaseBarrier(plan, args.prior, {
        persist: (state) => runtime.persist(state),
        execute: ({ step, prior, checkpoint }) => runtime.execute(step, prior, checkpoint),
        reverify: ({ step, prior }) => runtime.reverify(step, prior),
      });
      if (result.status === "ready") return { status: "ready", note: result.note, headSha: result.headSha };
      if (result.status === "not_required") return result;
      return { status: "blocked", note: result.note };
    } finally {
      await runtime.cleanup();
    }
  };
}
