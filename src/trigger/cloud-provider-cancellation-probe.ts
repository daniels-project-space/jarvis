import { createHash } from "node:crypto";
import type { CloudWorkspace, CloudWorkspaceProvider, ExecRequest, ExecResult } from "./cloud-workspace";

export type RemoteCancellationEvidence = Readonly<{
  adapterCancelled: boolean;
  pidGone: boolean;
  processGone: boolean;
  markerAbsent: boolean;
}>;

type CancellationProbeRemote = Readonly<{
  exec(request: ExecRequest): Promise<ExecResult>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
}>;

type CancellationProbeOptions = Readonly<{
  markerDelayMs?: number;
  observationMarginMs?: number;
  startupPolls?: number;
  startupPollMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its probe deadline`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nodeCommand(source: string, args: readonly string[]): string {
  return ["node", "-e", shellQuote(source), ...args.map(shellQuote)].join(" ");
}

function strictRemoteObservation(value: unknown): value is Omit<RemoteCancellationEvidence, "adapterCancelled"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const observed = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(observed).sort()) === JSON.stringify(["markerAbsent", "pidGone", "processGone"])
    && observed.pidGone === true
    && observed.processGone === true
    && observed.markerAbsent === true;
}

export function exactRemoteCancellationObserved(evidence: RemoteCancellationEvidence): boolean {
  return evidence.adapterCancelled && evidence.pidGone && evidence.processGone && evidence.markerAbsent;
}

/** Do not invoke a signer until both adapter and independent remote evidence agree. */
export function issueAfterExactRemoteCancellation<T>(evidence: RemoteCancellationEvidence, issue: () => T): T {
  if (!exactRemoteCancellationObserved(evidence)) {
    throw new Error("exact remote command cancellation was not independently observed");
  }
  return issue();
}

/**
 * Exercise cancellation through the adapter, then use a new remote command to
 * prove the uniquely named process and PID are gone after its delayed marker
 * would have been written. Cleanup is a separate required remote command.
 */
export async function probeExactRemoteCancellation(
  remote: CancellationProbeRemote,
  runId: string,
  options: CancellationProbeOptions = {},
): Promise<RemoteCancellationEvidence> {
  const markerDelayMs = options.markerDelayMs ?? 8_000;
  const observationMarginMs = options.observationMarginMs ?? 750;
  const startupPolls = options.startupPolls ?? 12;
  const startupPollMs = options.startupPollMs ?? 250;
  const wait = options.wait ?? delay;
  const id = createHash("sha256").update(runId).digest("hex").slice(0, 24);
  const directory = `.jarvis-provider-probe/${id}`;
  const pidPath = `${directory}/process.pid`;
  const markerPath = `${directory}/post-delay.marker`;
  const processToken = `jarvis-cancel-${id}`;
  const launcher = [
    "const fs=require('node:fs');",
    "const [directory,pidPath,markerPath,token,delayMs]=process.argv.slice(1);",
    "fs.mkdirSync(directory,{recursive:true});",
    "process.title=token;",
    "fs.writeFileSync(pidPath,String(process.pid),{flag:'wx'});",
    "setTimeout(()=>fs.writeFileSync(markerPath,token,{flag:'wx'}),Number(delayMs));",
  ].join("");
  const observer = [
    "const fs=require('node:fs');",
    "const [pidPath,markerPath,token]=process.argv.slice(1);",
    "let pid=0;try{pid=Number(fs.readFileSync(pidPath,'utf8').trim());}catch{}",
    "let pidAlive=false;try{process.kill(pid,0);pidAlive=pid>0;}catch{}",
    "let tokenAlive=false;for(const entry of fs.readdirSync('/proc')){if(!/^\\d+$/.test(entry)||Number(entry)===process.pid)continue;try{if(fs.readFileSync(`/proc/${entry}/cmdline`,'utf8').includes(token)){tokenAlive=true;break;}}catch{}}",
    "const observed={pidGone:!pidAlive,processGone:!tokenAlive,markerAbsent:!fs.existsSync(markerPath)};",
    "process.stdout.write(JSON.stringify(observed));",
    "if(!observed.pidGone||!observed.processGone||!observed.markerAbsent)process.exitCode=23;",
  ].join("");
  const cleanup = [
    "const fs=require('node:fs');",
    "const [directory,token]=process.argv.slice(1);",
    "for(const entry of fs.readdirSync('/proc')){if(!/^\\d+$/.test(entry)||Number(entry)===process.pid)continue;try{if(fs.readFileSync(`/proc/${entry}/cmdline`,'utf8').includes(token))process.kill(Number(entry),'SIGKILL');}catch{}}",
    "fs.rmSync(directory,{recursive:true,force:true});",
    "try{fs.rmdirSync('.jarvis-provider-probe');}catch{}",
  ].join("");
  const abort = new AbortController();
  let pending: Promise<ExecResult> | undefined;
  let adapterCancelled = false;
  let pidReady = false;
  let pid = "";

  try {
    pending = remote.exec({
      command: nodeCommand(launcher, [directory, pidPath, markerPath, processToken, String(markerDelayMs)]),
      timeoutMs: markerDelayMs + 5_000,
      maxOutputBytes: 4_000,
      signal: abort.signal,
    });
    void pending.catch(() => undefined);
    for (let attempt = 0; attempt < startupPolls; attempt += 1) {
      try {
        pid = new TextDecoder().decode(await within(remote.readFile(pidPath, 64), 2_000, "remote PID checkpoint")).trim();
        if (/^[1-9]\d{0,11}$/.test(pid)) {
          pidReady = true;
          break;
        }
      } catch { /* the PID file is the remote startup checkpoint */ }
      await wait(startupPollMs);
    }
    if (!pidReady) return { adapterCancelled: false, pidGone: false, processGone: false, markerAbsent: false };

    abort.abort();
    try {
      await within(pending, 5_000, "adapter cancellation response");
    } catch (error) {
      adapterCancelled = Boolean(error && typeof error === "object" && "code" in error && error.code === "cancelled");
    }
    await wait(markerDelayMs + observationMarginMs);
    const result = await within(remote.exec({
      command: nodeCommand(observer, [pidPath, markerPath, processToken]),
      timeoutMs: 5_000,
      maxOutputBytes: 4_000,
    }), 7_000, "independent remote cancellation observation");
    let observed: unknown;
    try { observed = JSON.parse(result.stdout); } catch { observed = null; }
    const independent = result.exitCode === 0 && strictRemoteObservation(observed)
      ? observed
      : { pidGone: false, processGone: false, markerAbsent: false };
    return { adapterCancelled, ...independent };
  } finally {
    abort.abort();
    const cleanupResult = await within(remote.exec({
      command: nodeCommand(cleanup, [directory, processToken]),
      timeoutMs: 5_000,
      maxOutputBytes: 4_000,
    }), 7_000, "remote cancellation probe cleanup");
    if (cleanupResult.exitCode !== 0) throw new Error("remote cancellation probe cleanup failed");
  }
}

export function cloudWorkspaceCancellationProbeRemote(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
): CancellationProbeRemote {
  return {
    exec: (request) => provider.exec(workspace, { ...request, cwd: workspace.root }),
    readFile: (path, maxBytes) => provider.readFile(workspace, path, maxBytes),
  };
}
