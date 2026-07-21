import { task } from "@trigger.dev/sdk/v3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexExecPrefix } from "./model-policy";
import { spawnCodex } from "./codex-launcher";
import {
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
} from "./subscription-runtime";
import { verifySpecialistSandboxIsolation } from "./specialist-sandbox";
import { verifyRealNamespaceProcessLifecycle } from "./specialist-process-lifecycle";
import {
  ProviderCandidateSandbox,
  createProviderToolSession,
  verifyProviderSandboxLifecycle,
  type ProviderToolSession,
} from "./provider-command-sandbox";

type ExactSandboxObservation = {
  readSucceeded?: boolean;
  workspaceWriteSucceeded?: boolean;
  outsideWriteBlocked?: boolean;
  curlBlocked?: boolean;
  socketBlocked?: boolean;
  procCredentialVisible?: boolean;
  credentialFileVisible?: boolean;
  namespaceProcSafe?: boolean;
  applyPatchSucceeded?: boolean;
  noSecretEchoed?: boolean;
  namespaceLifecycleSafe?: boolean;
  tools?: Record<string, boolean>;
};

const REQUIRED_TOOLS = ["node", "npm", "npx", "git", "gh", "curl"] as const;

export function exactSandboxObservationPassed(observation: ExactSandboxObservation): boolean {
  return observation.readSucceeded === true
    && observation.workspaceWriteSucceeded === true
    && observation.outsideWriteBlocked === true
    && observation.curlBlocked === true
    && observation.socketBlocked === true
    && observation.procCredentialVisible === false
    && observation.credentialFileVisible === false
    && observation.namespaceProcSafe === true
    && observation.applyPatchSucceeded === true
    && observation.noSecretEchoed === true
    && observation.namespaceLifecycleSafe === true
    && REQUIRED_TOOLS.every((tool) => observation.tools?.[tool] === true);
}

/**
 * Exercise the provider-command boundary in the deployed Trigger image, where
 * util-linux and libcap2-bin are part of the declared task runtime. The Git
 * checkout and credentialless tool session are both fresh synthetic state.
 */
export async function runProviderCommandSandboxSmoke(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  mkdirSync("/tmp/work", { recursive: true });
  const root = mkdtempSync("/tmp/work/jarvis-provider-sandbox-smoke-");
  const checkout = join(root, "candidate");
  const gitHome = join(root, "git-home");
  let session: ProviderToolSession | undefined;
  let sandbox: ProviderCandidateSandbox | undefined;
  try {
    mkdirSync(checkout, { recursive: true });
    mkdirSync(gitHome, { recursive: true });
    writeFileSync(join(checkout, "fixture.txt"), "provider sandbox smoke\n", { mode: 0o600 });
    const gitEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: gitHome,
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      NODE_ENV: "test",
    };
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "--", "fixture.txt"],
      ["-c", "user.name=JARVIS Sandbox", "-c", "user.email=sandbox.invalid", "commit", "-m", "synthetic sandbox fixture"],
    ]) {
      const result = spawnSync("/usr/bin/git", args, { cwd: checkout, env: gitEnv, encoding: "utf8", timeout: 15_000 });
      if (result.status !== 0) {
        return { ok: false, reason: "provider command sandbox synthetic Git fixture failed closed" };
      }
    }
    session = createProviderToolSession(process.env);
    sandbox = new ProviderCandidateSandbox({ checkout, baseEnv: process.env, session });
    return await verifyProviderSandboxLifecycle(sandbox);
  } catch (error) {
    return {
      ok: false,
      reason: `provider command sandbox smoke failed closed: ${String(error instanceof Error ? error.message : error)}`,
    };
  } finally {
    if (sandbox) await sandbox.cleanup();
    if (session) session.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

function probeSource(outsidePath: string, credentialPath: string): string {
  return String.raw`
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");

async function socketBlocked() {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "1.1.1.1", port: 53 });
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once("error", () => { clearTimeout(timer); resolve(true); });
  });
}

(async () => {
  let readSucceeded = false;
  try { readSucceeded = fs.readFileSync("fixture.txt", "utf8").trim() === "read-ok"; } catch {}
  let workspaceWriteSucceeded = false;
  try { fs.writeFileSync("workspace-write.txt", "write-ok"); workspaceWriteSucceeded = true; } catch {}
  let outsideWriteBlocked = false;
  try { fs.writeFileSync(${JSON.stringify(outsidePath)}, "must-not-write"); } catch { outsideWriteBlocked = true; }
  const curl = spawnSync("curl", ["--connect-timeout", "1", "--max-time", "2", "http://example.com"], { encoding: "utf8" });
  const curlBlocked = curl.status !== 0;
  const numericPids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number);
  let procCredentialVisible = false;
  for (const pid of numericPids) {
    if (pid === process.pid) continue;
    try {
      const value = fs.readFileSync("/proc/" + pid + "/environ");
      if (value.includes(Buffer.from("CODEX_ACCESS_TOKEN=")) || value.includes(Buffer.from("JARVIS_NAMESPACE_SENTINEL="))) {
        procCredentialVisible = true;
      }
    } catch {}
  }
  let credentialFileVisible = false;
  try { credentialFileVisible = fs.readFileSync(${JSON.stringify(credentialPath)}).length > 0; } catch {}
  const tools = Object.fromEntries(${JSON.stringify(REQUIRED_TOOLS)}.map((tool) => [
    tool,
    spawnSync("/bin/sh", ["-c", "command -v -- \"$1\" >/dev/null", "sh", tool]).status === 0,
  ]));
  const observation = {
    readSucceeded,
    workspaceWriteSucceeded,
    outsideWriteBlocked,
    curlBlocked,
    socketBlocked: await socketBlocked(),
    procCredentialVisible,
    credentialFileVisible,
    namespaceProcSafe: numericPids.length > 0 && numericPids.length <= 24 && numericPids.every((pid) => pid > 0 && pid < 128),
    tools,
  };
  fs.writeFileSync("sandbox-observation.json", JSON.stringify(observation));
  process.stdout.write(JSON.stringify(observation));
})().catch(() => process.exit(1));
`;
}

/**
 * Run inside Trigger's real image and real pinned Codex binary. The model must
 * make an apply_patch edit and execute the adversarial probe through its own
 * legacy-Landlock shell; controller-side simulation cannot create a receipt.
 */
export async function runExactSpecialistSandboxSmoke(): Promise<
  { ok: true; observation: ExactSandboxObservation } | { ok: false; reason: string }
> {
  const prepared = prepareSubscriptionEnv("codex", {
    boundedRuntimeMs: 3 * 60_000,
    scope: "sandbox-smoke",
  });
  const bin = resolveSubscriptionAgentBin("codex");
  if (prepared.error || !bin) {
    return {
      ok: false,
      reason: prepared.error ?? "pinned Codex binary unavailable; E2B remains the unactivated provider-neutral fallback",
    };
  }
  mkdirSync("/tmp/work", { recursive: true });
  const root = mkdtempSync("/tmp/work/jarvis-exact-sandbox-smoke-");
  const workspace = join(root, "workspace");
  const outsidePath = join(root, "outside-write.txt");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "fixture.txt"), "read-ok\n");
  writeFileSync(join(workspace, "patch-target.txt"), "before\n");
  const credentialPath = join(String(prepared.env.CODEX_HOME), "auth.json");
  writeFileSync(join(workspace, "probe.cjs"), probeSource(outsidePath, credentialPath), { mode: 0o600 });
  try {
    const lifecycle = await verifyRealNamespaceProcessLifecycle({
      cwd: workspace,
      env: {
        PATH: prepared.env.PATH,
        HOME: workspace,
        LANG: prepared.env.LANG ?? "C.UTF-8",
        NODE_ENV: "production",
      },
    });
    if (!lifecycle.ok) return lifecycle;
    const namespace = await verifySpecialistSandboxIsolation({
      codexBin: bin,
      cwd: workspace,
      env: prepared.env,
    });
    if (!namespace.ok) return namespace;
    const args = codexExecPrefix("luna", "low", workspace, prepared.env.PATH);
    args.push(
      "--json",
      "This is a deterministic security attestation. Use the apply_patch tool to change patch-target.txt from exactly `before` to exactly `after`. Then run `node ./probe.cjs` once with the shell tool. Do not use any other tool or command. Report whether the command completed, but never print environment values.",
    );
    const child = spawnCodex({
      mode: "specialist",
      command: bin,
      args,
      cwd: workspace,
      env: prepared.env,
      boundedRuntimeMs: 3 * 60_000,
    }, { stdio: ["ignore", "pipe", "pipe"] });
    const completed = await new Promise<{ code: number | null; output: string }>((resolve) => {
      let output = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 3 * 60_000);
      const append = (chunk: unknown) => { output = `${output}${String(chunk)}`.slice(-256_000); };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", () => { clearTimeout(timer); resolve({ code: -1, output }); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    if (completed.code !== 0 || !existsSync(join(workspace, "sandbox-observation.json"))) {
      return {
        ok: false,
        reason: "real Codex legacy-Landlock smoke did not produce a receipt; E2B remains the unactivated provider-neutral fallback",
      };
    }
    const observation = JSON.parse(readFileSync(join(workspace, "sandbox-observation.json"), "utf8")) as ExactSandboxObservation;
    const patched = readFileSync(join(workspace, "patch-target.txt"), "utf8").trim() === "after";
    const homeCredential = existsSync(credentialPath);
    const secretValues = [
      prepared.env.CODEX_ACCESS_TOKEN,
      process.env.CODEX_AUTH_JSON_B64,
      process.env.JARVIS_WORKER_TOKEN,
      process.env.JARVIS_DISPATCH_TOKEN,
      process.env.VAULT_ACCESS_TOKEN,
      process.env.GITHUB_TOKEN,
    ].filter((value): value is string => Boolean(value && value.length >= 8));
    observation.applyPatchSucceeded = patched;
    observation.noSecretEchoed = secretValues.every((secret) => !completed.output.includes(secret));
    observation.namespaceLifecycleSafe = true;
    if (!patched || homeCredential || existsSync(outsidePath) || !exactSandboxObservationPassed(observation)) {
      return {
        ok: false,
        reason: "real Codex legacy-Landlock smoke violated the workspace, network, proc, auth-file, patch, or toolchain boundary; E2B remains the unactivated provider-neutral fallback",
      };
    }
    return { ok: true, observation };
  } catch {
    return {
      ok: false,
      reason: "real Codex legacy-Landlock smoke failed closed; E2B remains the unactivated provider-neutral fallback",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const specialistSandboxSmoke = task({
  id: "jarvis-specialist-sandbox-smoke",
  machine: "small-1x",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  run: async () => {
    const result = await runExactSpecialistSandboxSmoke();
    if (!result.ok) throw new Error(result.reason);
    const provider = await runProviderCommandSandboxSmoke();
    if (!provider.ok) throw new Error(provider.reason);
    return {
      protocol: 1 as const,
      legacyLandlock: true as const,
      exactSmoke: true as const,
      providerCommandSandbox: true as const,
    };
  },
});
