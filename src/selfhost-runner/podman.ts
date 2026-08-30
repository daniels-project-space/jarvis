import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunnerLimits, RunnerWorkspace, SelfHostedRunnerBackend } from "./runner";

type ProcessResult = Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; durationMs: number }>;

export type RunnerProcessOptions = Readonly<{
  input?: Uint8Array;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}>;

export interface RunnerProcess {
  run(executable: string, args: readonly string[], options: RunnerProcessOptions): Promise<ProcessResult>;
}

class PodmanError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PodmanError";
  }
}

export class SpawnRunnerProcess implements RunnerProcess {
  async run(executable: string, args: readonly string[], options: RunnerProcessOptions): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(executable, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }) as ChildProcessWithoutNullStreams;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const kill = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const finish = (error?: unknown, result?: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => { kill(); finish(new PodmanError("cancelled")); };
      const timer = setTimeout(() => { kill(); finish(new PodmanError("timeout")); }, options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => finish(error));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > options.maxStdoutBytes) { kill(); finish(new PodmanError("stdout_limit")); return; }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > options.maxStderrBytes) { kill(); finish(new PodmanError("stderr_limit")); return; }
        stderr.push(chunk);
      });
      child.on("close", (code) => finish(undefined, {
        exitCode: Number.isInteger(code) ? Number(code) : -1,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr)),
        durationMs: Date.now() - startedAt,
      }));
      if (options.input) child.stdin.end(Buffer.from(options.input)); else child.stdin.end();
      if (options.signal?.aborted) abort();
    });
  }
}

const PATH_SCRIPT = String.raw`
const fs=require("node:fs"),path=require("node:path");
const root="/workspace",target=path.posix.normalize(process.argv[1]);
if(!target.startsWith(root+"/")||target!==process.argv[1])process.exit(41);
let current=root;
for(const part=path.posix.relative(root,target).split("/");part.length;){
  current=path.posix.join(current,part.shift());
  try{if(fs.lstatSync(current).isSymbolicLink())process.exit(42)}catch(error){if(error.code!=="ENOENT")throw error}
}
`;

const WRITE_SCRIPT = `${PATH_SCRIPT}
const max=Number(process.argv[2]),chunks=[];let size=0;
process.stdin.on("data",chunk=>{size+=chunk.length;if(size>max)process.exit(43);chunks.push(chunk)});
process.stdin.on("end",()=>{fs.mkdirSync(path.posix.dirname(target),{recursive:true,mode:0o700});const flags=fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW;const fd=fs.openSync(target,flags,0o600);try{fs.writeFileSync(fd,Buffer.concat(chunks))}finally{fs.closeSync(fd)}});
`;

const READ_SCRIPT = `${PATH_SCRIPT}
const max=Number(process.argv[2]),stat=fs.lstatSync(target);
if(!stat.isFile()||stat.size>max)process.exit(43);
process.stdout.write(fs.readFileSync(target));
`;

const LIST_SCRIPT = `${PATH_SCRIPT}
const max=Number(process.argv[2]),stat=fs.lstatSync(target);if(!stat.isDirectory())process.exit(44);
const entries=fs.readdirSync(target,{withFileTypes:true});if(entries.length>max)process.exit(43);
const values=entries.map(entry=>{if(entry.isSymbolicLink())process.exit(42);return entry.name}).sort();
process.stdout.write(JSON.stringify(values));
`;

const EXEC_WRAPPER = String.raw`
set -eu
umask 077
mv "$2" "$3"
setsid /bin/sh -c 'printf "%s" "$$" > "$1"; exec /bin/sh -lc "$2"' runner-child "$4" "$1" &
pid=$!
set +e
wait "$pid"
status=$?
set -e
rm -f "$2" "$3" "$4"
exit "$status"
`;

const KILL_WRAPPER = String.raw`
set -eu
rm -f "$1"
i=0
while [ "$i" -lt 40 ]; do
  if [ -f "$3" ]; then
    pid=$(cat "$3")
    case "$pid" in (*[!0-9]*|'') exit 43;; esac
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$2" "$3"
    exit 0
  fi
  [ -f "$2" ] || exit 0
  i=$((i+1))
  sleep 0.05
done
exit 44
`;

const CREATE_LEASE_WRAPPER = String.raw`
set -eu
umask 077
[ ! -e "$1" ] && [ ! -e "$2" ] && [ ! -e "$3" ]
: > "$1"
`;

function utf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

export type PodmanRunnerConfig = Readonly<{
  executable: string;
  image: string;
  workspaceTmpfsMb: number;
  user: string;
}>;

export class PodmanSelfHostedRunnerBackend implements SelfHostedRunnerBackend {
  constructor(
    private readonly config: PodmanRunnerConfig,
    private readonly process: RunnerProcess = new SpawnRunnerProcess(),
  ) {
    if (!/^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(config.image)) {
      throw new Error("runner image must be pinned by sha256 digest");
    }
    if (config.executable !== "podman") throw new Error("only the rootless Podman runtime is accepted");
    if (!/^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/.test(config.user)) throw new Error("runner container user must be a numeric uid:gid");
  }

  private async podman(args: readonly string[], options: Partial<RunnerProcessOptions> = {}): Promise<ProcessResult> {
    return await this.process.run(this.config.executable, args, {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxStdoutBytes: options.maxStdoutBytes ?? 64 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
      input: options.input,
      signal: options.signal,
    });
  }

  async create(workspaceId: string, limits: RunnerLimits): Promise<{ containerId: string }> {
    const name = `jarvis-${workspaceId}`;
    const result = await this.podman([
      "run", "--detach", "--rm", "--name", name,
      "--label", "io.jarvis.selfhost-runner=1",
      "--label", `io.jarvis.workspace=${workspaceId}`,
      "--network", "none",
      "--cpus", String(limits.cpu),
      "--memory", `${limits.memoryMb}m`,
      "--pids-limit", "512",
      "--cap-drop", "all",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--user", this.config.user,
      "--hostname", "jarvis-workspace",
      "--env", "HOME=/tmp",
      "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env", "LANG=C",
      "--env", "LC_ALL=C",
      "--tmpfs", `/workspace:rw,nosuid,nodev,size=${this.config.workspaceTmpfsMb}m,mode=0700,uid=${this.config.user.split(":")[0]},gid=${this.config.user.split(":")[1]}`,
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=256m,mode=0700,uid=${this.config.user.split(":")[0]},gid=${this.config.user.split(":")[1]}`,
      "--entrypoint", "/bin/sh",
      this.config.image,
      "-c", "mkdir -p /workspace/repository && exec sleep infinity",
    ], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new PodmanError("container_create_failed");
    const containerId = utf8(result.stdout).trim();
    if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
      await this.podman(["rm", "--force", "--time", "0", name], { timeoutMs: 20_000 }).catch(() => undefined);
      throw new PodmanError("container_identity_invalid");
    }
    return { containerId };
  }

  async isRunning(workspace: RunnerWorkspace): Promise<boolean> {
    const result = await this.podman(["inspect", "--format", "{{.State.Running}}", workspace.containerId], { timeoutMs: 10_000 });
    if (result.exitCode === 0) return utf8(result.stdout).trim() === "true";
    if (/no such (?:object|container)/i.test(utf8(result.stderr))) return false;
    throw new PodmanError("container_inspection_failed");
  }

  private async killCommand(workspace: RunnerWorkspace, leasePath: string, startedPath: string, pidPath: string): Promise<void> {
    const result = await this.podman([
      "exec", workspace.containerId, "/bin/sh", "-c", KILL_WRAPPER,
      "runner-kill", leasePath, startedPath, pidPath,
    ], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new PodmanError("command_cancellation_unproven");
  }

  async exec(workspace: RunnerWorkspace, request: { command: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }) {
    const commandId = randomBytes(16).toString("hex");
    const leasePath = `/workspace/.jarvis-runner-${commandId}.lease`;
    const startedPath = `/workspace/.jarvis-runner-${commandId}.started`;
    const pidPath = `/workspace/.jarvis-runner-${commandId}.pid`;
    const lease = await this.podman([
      "exec", workspace.containerId, "/bin/sh", "-c", CREATE_LEASE_WRAPPER,
      "runner-lease", leasePath, startedPath, pidPath,
    ], { timeoutMs: 5_000 });
    if (lease.exitCode !== 0) throw new PodmanError("command_lease_rejected");
    const execution = new AbortController();
    const timer = setTimeout(() => execution.abort(), request.timeoutMs);
    const onAbort = () => execution.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    let kill: Promise<void> | undefined;
    const stop = () => { kill ??= this.killCommand(workspace, leasePath, startedPath, pidPath); };
    execution.signal.addEventListener("abort", stop, { once: true });
    try {
      const result = await this.podman([
        "exec", "--workdir", "/workspace/repository", workspace.containerId,
        "/bin/sh", "-c", EXEC_WRAPPER, "runner-exec",
        request.command, leasePath, startedPath, pidPath,
      ], {
        timeoutMs: request.timeoutMs + 2_000,
        maxStdoutBytes: request.maxOutputBytes,
        maxStderrBytes: request.maxOutputBytes,
        signal: execution.signal,
      });
      if (execution.signal.aborted) throw new PodmanError(request.signal.aborted ? "cancelled" : "timeout");
      return { exitCode: result.exitCode, stdout: utf8(result.stdout), stderr: utf8(result.stderr), durationMs: result.durationMs };
    } catch (error) {
      stop();
      await kill;
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      await this.podman([
        "exec", workspace.containerId, "rm", "-f", leasePath, startedPath, pidPath,
      ], { timeoutMs: 5_000 }).catch(() => undefined);
    }
  }

  async readFile(workspace: RunnerWorkspace, path: string, maxBytes: number): Promise<Uint8Array> {
    const result = await this.podman(["exec", workspace.containerId, "node", "-e", READ_SCRIPT, path, String(maxBytes)], {
      timeoutMs: 20_000,
      maxStdoutBytes: maxBytes,
    });
    if (result.exitCode !== 0) throw new PodmanError("file_read_rejected");
    return result.stdout;
  }

  async writeFile(workspace: RunnerWorkspace, path: string, value: Uint8Array, maxBytes: number): Promise<void> {
    const result = await this.podman(["exec", "--interactive", workspace.containerId, "node", "-e", WRITE_SCRIPT, path, String(maxBytes)], {
      input: value,
      timeoutMs: 20_000,
      maxStdoutBytes: 4_096,
    });
    if (result.exitCode !== 0) throw new PodmanError("file_write_rejected");
  }

  async listFiles(workspace: RunnerWorkspace, path: string, maxEntries: number): Promise<string[]> {
    const result = await this.podman(["exec", workspace.containerId, "node", "-e", LIST_SCRIPT, path, String(maxEntries)], {
      timeoutMs: 20_000,
      maxStdoutBytes: Math.max(1_024, maxEntries * 2_048),
    });
    if (result.exitCode !== 0) throw new PodmanError("file_list_rejected");
    const parsed: unknown = JSON.parse(utf8(result.stdout));
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry || entry.includes("/") || entry.includes("\\"))) {
      throw new PodmanError("file_list_invalid");
    }
    return parsed;
  }

  async remove(workspace: RunnerWorkspace): Promise<void> {
    const result = await this.podman(["rm", "--force", "--time", "0", workspace.containerId], { timeoutMs: 20_000 });
    const detail = utf8(result.stderr).toLowerCase();
    if (result.exitCode !== 0 && !detail.includes("no such container")) throw new PodmanError("container_delete_failed");
  }
}
