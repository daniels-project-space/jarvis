import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_BINARY = "/usr/bin/bwrap";
const SENSITIVE_CAPABILITY_NAMES = [
  "VAULT_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "TRIGGER_ACCESS_TOKEN",
  "TRIGGER_SECRET_KEY",
  "VERCEL_TOKEN",
  "CONVEX_DEPLOY_KEY",
] as const;

type SandboxInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  writableCwd?: boolean;
  writablePaths?: readonly string[];
  readablePaths?: readonly string[];
  sandboxBinary?: string;
};

export type SpecialistSandboxInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

function absoluteExisting(path: string, label: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${label} must be an existing absolute path`);
  return normalize(path);
}

function directoryChain(path: string): string[] {
  const directories: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== ".") {
    directories.push(current);
    current = dirname(current);
  }
  return directories.reverse();
}

function addMount(args: string[], mounted: Set<string>, mode: "--bind" | "--ro-bind", path: string): void {
  const resolved = absoluteExisting(path, "sandbox mount");
  for (const directory of directoryChain(resolved)) {
    if (!mounted.has(directory)) {
      args.push("--dir", directory);
      mounted.add(directory);
    }
  }
  args.push(mode, resolved, resolved);
  mounted.add(resolved);
}

/**
 * Bubblewrap gives the Codex subprocess a separate PID namespace and a
 * capability-minimal filesystem. Environment filtering is retained as defence
 * in depth; it is not treated as the isolation boundary.
 */
export function buildSpecialistSandboxInvocation(input: SandboxInput): SpecialistSandboxInvocation {
  const sandboxBinary = input.sandboxBinary ?? SANDBOX_BINARY;
  const cwd = absoluteExisting(input.cwd, "specialist cwd");
  const command = absoluteExisting(input.command, "specialist executable");
  const codexHome = absoluteExisting(String(input.env.CODEX_HOME ?? ""), "specialist CODEX_HOME");
  for (const name of SENSITIVE_CAPABILITY_NAMES) {
    if (input.env[name] !== undefined) throw new Error(`specialist environment contains forbidden controller capability ${name}`);
  }
  const mounted = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--cap-drop", "ALL",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/usr/local", "/usr/local",
    "--ro-bind-try", "/etc", "/etc",
    "--ro-bind-try", "/app", "/app",
  ];
  addMount(args, mounted, input.writableCwd === false ? "--ro-bind" : "--bind", cwd);
  addMount(args, mounted, "--bind", codexHome);
  for (const path of input.writablePaths ?? []) addMount(args, mounted, "--bind", path);
  for (const path of input.readablePaths ?? []) addMount(args, mounted, "--ro-bind", path);
  args.push("--clearenv");
  for (const [key, value] of Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))) {
    if (value !== undefined) args.push("--setenv", key, value);
  }
  args.push("--chdir", cwd, "--", command, ...input.args);
  return {
    command: sandboxBinary,
    args,
    cwd: "/",
    // Bubblewrap receives no application/provider authority before it creates
    // the namespace. The explicitly scoped child environment is supplied only
    // through --setenv after --clearenv.
    env: {
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/",
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  };
}

export function spawnSpecialist(
  input: SandboxInput,
  options: Omit<SpawnOptions, "cwd" | "env"> = {},
): ChildProcessWithoutNullStreams {
  const invocation = buildSpecialistSandboxInvocation(input);
  return spawn(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd,
    env: invocation.env,
  }) as ChildProcessWithoutNullStreams;
}

const ADVERSARY_SOURCE = `
const fs = require("node:fs");
const names = ${JSON.stringify(SENSITIVE_CAPABILITY_NAMES.map((name) => `${name}=`))};
let procExposed = false;
for (const entry of fs.readdirSync("/proc")) {
  if (!/^\\d+$/.test(entry) || Number(entry) === process.pid) continue;
  try {
    const value = fs.readFileSync("/proc/" + entry + "/environ");
    if (names.some((name) => value.includes(Buffer.from(name)))) procExposed = true;
  } catch {}
}
let fileExposed = false;
try { fileExposed = fs.readFileSync(process.argv[1], "utf8").length > 0; } catch {}
process.stdout.write(JSON.stringify({ procExposed, fileExposed }));
`;

/** Run a synthetic adversary before a specialist lease; unavailable or leaky isolation fails closed. */
export function verifySpecialistSandboxIsolation(input: {
  command?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sandboxBinary?: string;
}): { ok: true } | { ok: false; reason: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sandbox-probe-"));
  const sentinel = join(root, "provider-release-sentinel");
  writeFileSync(sentinel, "synthetic sentinel only", { mode: 0o600 });
  try {
    const invocation = buildSpecialistSandboxInvocation({
      command: input.command ?? process.execPath,
      args: ["-e", ADVERSARY_SOURCE, sentinel],
      cwd: input.cwd,
      env: input.env,
      sandboxBinary: input.sandboxBinary,
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.status !== 0) return { ok: false, reason: "specialist OS sandbox is unavailable" };
    const observation = JSON.parse(String(result.stdout || "{}")) as { procExposed?: boolean; fileExposed?: boolean };
    if (observation.procExposed || observation.fileExposed) {
      return { ok: false, reason: "specialist OS sandbox exposed parent process or filesystem authority" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "specialist OS sandbox probe failed" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
