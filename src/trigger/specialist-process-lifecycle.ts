export type SpecialistStopState = {
  timedOut: boolean;
  stopped: "paused" | "cancelled" | null;
};

type ManagedChild = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export type SpecialistExit = SpecialistStopState & {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

/**
 * A release controller may not load provider authority merely because it sent
 * a signal to a specialist. Only ChildProcess `close` proves that the outer
 * namespace process and all of its stdio handles are gone; unshare's PID-1
 * teardown then guarantees no detached model child survived to overlap the
 * trusted controller phase.
 */
export function createSpecialistExitBarrier(child: ManagedChild): {
  exited: Promise<SpecialistExit>;
  requestStop: (state: SpecialistStopState, forceAfterMs?: number) => void;
} {
  let requested: SpecialistStopState = { timedOut: false, stopped: null };
  let stopRequested = false;
  let processError: Error | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const exited = new Promise<SpecialistExit>((resolve) => {
    child.once("error", (error) => {
      // Node emits `close` after a spawn error too. Keep waiting for that
      // terminal event instead of weakening the credential handoff barrier.
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ...requested, code, signal, error: processError });
    });
  });

  const requestStop = (state: SpecialistStopState, forceAfterMs = 0) => {
    if (stopRequested) return;
    stopRequested = true;
    requested = state;
    try {
      child.kill(forceAfterMs > 0 ? "SIGTERM" : "SIGKILL");
    } catch {
      // A concurrent natural exit still has to produce `close` before release.
    }
    if (forceAfterMs > 0) {
      forceKillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already closed */ }
      }, forceAfterMs);
      forceKillTimer.unref?.();
    }
  };

  return { exited, requestStop };
}

const DETACHED_GRANDCHILD_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const marker = process.argv[1];
const childSource = "const fs=require('node:fs');const marker=process.argv[1];setTimeout(()=>fs.writeFileSync(marker,'survived'),1200);setInterval(()=>{},1000);";
const child = spawn(process.execPath, ["-e", childSource, marker], { detached: true, stdio: "ignore" });
child.unref();
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
`;

/**
 * Exercise the real outer namespace lifecycle used in Trigger. Both forced
 * timeout and graceful pause paths must close unshare before trusted work can
 * begin, and killing namespace PID 1 must reap a detached grandchild.
 */
export async function verifyRealNamespaceProcessLifecycle(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  unshareBinary?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    for (const scenario of ["timeout", "pause"] as const) {
      const marker = join(input.cwd, `.jarvis-detached-${scenario}-${process.pid}`);
      rmSync(marker, { force: true });
      const invocation = buildPrivateProcNamespaceInvocation({
        command: process.execPath,
        args: ["-e", DETACHED_GRANDCHILD_SOURCE, marker],
        cwd: input.cwd,
        env: input.env,
        unshareBinary: input.unshareBinary,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const barrier = createSpecialistExitBarrier(child);
      const ready = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("READY")) finish(true);
        });
        child.once("error", () => finish(false));
        child.once("close", () => finish(false));
      });
      if (!ready) {
        barrier.requestStop({ timedOut: true, stopped: null });
        await barrier.exited;
        return { ok: false, reason: "real namespace lifecycle probe could not start" };
      }

      let closeObserved = false;
      let trustedReleaseBeforeClose = false;
      child.once("close", () => { closeObserved = true; });
      const trustedRelease = barrier.exited.then(() => {
        if (!closeObserved) trustedReleaseBeforeClose = true;
      });
      if (scenario === "timeout") barrier.requestStop({ timedOut: true, stopped: null });
      else barrier.requestStop({ timedOut: false, stopped: "paused" }, 200);
      if (trustedReleaseBeforeClose) {
        return { ok: false, reason: "trusted capability release began before namespace close" };
      }
      await trustedRelease;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      if (!closeObserved || trustedReleaseBeforeClose || existsSync(marker)) {
        rmSync(marker, { force: true });
        return { ok: false, reason: "namespace PID 1 did not reap a detached specialist grandchild" };
      }
      rmSync(marker, { force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "real namespace lifecycle probe failed closed" };
  }
}
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildPrivateProcNamespaceInvocation } from "./codex-launcher";
