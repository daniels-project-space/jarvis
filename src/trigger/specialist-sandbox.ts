import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildPrivateProcNamespaceInvocation } from "./codex-launcher";

const SYNTHETIC_CODEX_TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.synthetic";
const REQUIRED_TOOLS = ["node", "npm", "npx", "git", "gh", "curl"] as const;

export type NamespaceProbeInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type NamespaceObservation = {
  controllerVisible?: boolean;
  parentReadable?: boolean;
  parentTokenVisible?: boolean;
  foreignEnvironmentVisible?: boolean;
  numericPids?: number[];
  selfPid?: number;
  tools?: Record<string, boolean>;
};

const NAMESPACE_PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const outerPid = String(process.argv[1] || "");
const numericPids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => a - b);
let controllerVisible = false;
try { fs.accessSync("/proc/" + outerPid + "/environ"); controllerVisible = true; } catch {}
let parentReadable = false;
let parentTokenVisible = false;
try {
  const parent = fs.readFileSync("/proc/" + process.ppid + "/environ");
  parentReadable = true;
  parentTokenVisible = parent.includes(Buffer.from("CODEX_ACCESS_TOKEN="));
} catch {}
let foreignEnvironmentVisible = false;
for (const pid of numericPids) {
  if (pid === process.pid) continue;
  try {
    const value = fs.readFileSync("/proc/" + pid + "/environ");
    if (value.includes(Buffer.from("CODEX_ACCESS_TOKEN=")) || value.includes(Buffer.from("JARVIS_WORKER_TOKEN="))) {
      foreignEnvironmentVisible = true;
    }
  } catch {}
}
const tools = Object.fromEntries(${JSON.stringify(REQUIRED_TOOLS)}.map((tool) => [
  tool,
  spawnSync("/usr/bin/env", ["-i", "PATH=" + process.env.PATH, "/bin/sh", "-c", "command -v -- \"$1\" >/dev/null", "sh", tool]).status === 0,
]));
process.stdout.write(JSON.stringify({
  controllerVisible,
  parentReadable,
  parentTokenVisible,
  foreignEnvironmentVisible,
  numericPids,
  selfPid: process.pid,
  tools,
}));
`;

/**
 * Build the deterministic preflight exactly as it runs in Trigger: fresh user
 * and PID namespaces first, then the pinned Codex Linux sandbox forced onto
 * the supported legacy Landlock path. `env -i` models a model-generated shell
 * child with no inherited credential.
 */
export function buildSpecialistNamespaceProbeInvocation(input: {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  controllerPid?: number;
  unshareBinary?: string;
}): NamespaceProbeInvocation {
  const cwd = input.cwd;
  const path = input.env.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    NODE_ENV: input.env.NODE_ENV ?? "production",
    HOME: String(input.env.HOME ?? cwd),
    CODEX_HOME: String(input.env.CODEX_HOME ?? ""),
    CODEX_ACCESS_TOKEN: SYNTHETIC_CODEX_TOKEN,
    LANG: input.env.LANG ?? "C.UTF-8",
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  return buildPrivateProcNamespaceInvocation({
    command: input.codexBin,
    args: [
      "sandbox",
      "-P",
      ":read-only",
      "-c",
      "features.use_legacy_landlock=true",
      "-C",
      cwd,
      "--",
      "/usr/bin/env",
      "-i",
      `PATH=${path}`,
      `HOME=${cwd}`,
      "node",
      "-e",
      NAMESPACE_PROBE_SOURCE,
      String(input.controllerPid ?? process.pid),
    ],
    cwd,
    env,
    unshareBinary: input.unshareBinary,
  });
}

/** Run a sentinel-only adversary before a specialist lease; any uncertainty fails closed. */
export function verifySpecialistSandboxIsolation(input: {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  unshareBinary?: string;
}): { ok: true; observation: NamespaceObservation } | { ok: false; reason: string } {
  let root = "";
  try {
    root = mkdtempSync(join(input.cwd, ".jarvis-namespace-probe-"));
    const invocation = buildSpecialistNamespaceProbeInvocation({
      ...input,
      cwd: root,
      controllerPid: process.pid,
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "specialist legacy-Landlock namespace is unavailable; E2B remains the unactivated provider-neutral fallback",
      };
    }
    const observation = JSON.parse(String(result.stdout || "{}")) as NamespaceObservation;
    const toolchainComplete = REQUIRED_TOOLS.every((tool) => observation.tools?.[tool] === true);
    const pids = observation.numericPids ?? [];
    const namespaceSafeProc = pids.length > 0
      && pids.length <= 16
      && pids.every((pid) => Number.isInteger(pid) && pid > 0 && pid < 128)
      && pids.includes(Number(observation.selfPid));
    if (
      observation.controllerVisible
      || observation.parentReadable
      || observation.parentTokenVisible
      || observation.foreignEnvironmentVisible
      || !namespaceSafeProc
      || !toolchainComplete
    ) {
      return {
        ok: false,
        reason: "specialist namespace or legacy Landlock exposed parent authority or an incomplete toolchain; E2B remains the unactivated provider-neutral fallback",
      };
    }
    return { ok: true, observation };
  } catch {
    return {
      ok: false,
      reason: "specialist legacy-Landlock namespace probe failed; E2B remains the unactivated provider-neutral fallback",
    };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
