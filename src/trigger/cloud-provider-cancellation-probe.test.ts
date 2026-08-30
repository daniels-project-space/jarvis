import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceError, type ExecRequest, type ExecResult } from "./cloud-workspace";
import {
  exactRemoteCancellationObserved,
  issueAfterExactRemoteCancellation,
  probeExactRemoteCancellation,
} from "./cloud-provider-cancellation-probe";

const result = (stdout: string, exitCode = 0): ExecResult => ({
  exitCode, stdout, stderr: "", providerSessionId: "remote-session", durationMs: 1,
});

describe("independently observed provider cancellation", () => {
  it("cannot issue a PASS receipt when the adapter says cancelled but the remote process and marker remain", async () => {
    let call = 0;
    const remote = {
      readFile: vi.fn(async () => new TextEncoder().encode("4242")),
      exec: vi.fn((request: ExecRequest) => {
        call += 1;
        if (call === 1) {
          return new Promise<ExecResult>((_resolve, reject) => request.signal!.addEventListener("abort", () => {
            reject(new CloudWorkspaceError("sandbox0", "cancelled", "SDK reported cancellation", "deferred"));
          }, { once: true }));
        }
        if (call === 2) return Promise.resolve(result(JSON.stringify({ pidGone: false, processGone: false, markerAbsent: false }), 23));
        return Promise.resolve(result(""));
      }),
    };
    const evidence = await probeExactRemoteCancellation(remote, "deterministic-run", {
      markerDelayMs: 1, observationMarginMs: 0, startupPollMs: 0, wait: async () => undefined,
    });
    expect(evidence).toEqual({ adapterCancelled: true, pidGone: false, processGone: false, markerAbsent: false });
    expect(exactRemoteCancellationObserved(evidence)).toBe(false);
    const issue = vi.fn(() => ({ status: "PASS" }));
    expect(() => issueAfterExactRemoteCancellation(evidence, issue)).toThrow(/not independently observed/);
    expect(issue).not.toHaveBeenCalled();
    expect(remote.exec).toHaveBeenCalledTimes(3);
    const cleanup = remote.exec.mock.calls[2]?.[0];
    expect(cleanup.command).toContain("process.kill(-pid");
    expect(cleanup.command).not.toContain("readdirSync");
    const observer = remote.exec.mock.calls[1]?.[0];
    expect(observer.command).toContain("processGroupAlive");
    expect(observer.command).not.toContain("cmdline");
  });

  it.each([
    ["malformed", result("not-json")],
    ["failed", result(JSON.stringify({ pidGone: true, processGone: true, markerAbsent: true }), 23)],
  ])("rejects %s independent remote observation", async (_label, observation) => {
    let call = 0;
    const remote = {
      readFile: vi.fn(async () => new TextEncoder().encode("4242")),
      exec: vi.fn((request: ExecRequest) => {
        call += 1;
        if (call === 1) {
          return new Promise<ExecResult>((_resolve, reject) => request.signal!.addEventListener("abort", () => {
            reject(new CloudWorkspaceError("sandbox0", "cancelled", "SDK reported cancellation", "deferred"));
          }, { once: true }));
        }
        if (call === 2) return Promise.resolve(observation);
        return Promise.resolve(result(""));
      }),
    };
    await expect(probeExactRemoteCancellation(remote, `observation-${_label}`, {
      markerDelayMs: 1, observationMarginMs: 0, startupPollMs: 0, wait: async () => undefined,
    })).resolves.toEqual({ adapterCancelled: true, pidGone: false, processGone: false, markerAbsent: false });
  });

  it("refuses cancellation proof when the remote PID startup checkpoint is missing", async () => {
    let call = 0;
    const remote = {
      readFile: vi.fn(async () => { throw new Error("PID not written"); }),
      exec: vi.fn((request: ExecRequest) => {
        call += 1;
        if (call === 1) {
          return new Promise<ExecResult>((_resolve, reject) => request.signal!.addEventListener("abort", () => {
            reject(new CloudWorkspaceError("sandbox0", "cancelled", "cancelled during startup", "deferred"));
          }, { once: true }));
        }
        return Promise.resolve(result(""));
      }),
    };
    await expect(probeExactRemoteCancellation(remote, "missing-pid", {
      markerDelayMs: 1, startupPolls: 2, startupPollMs: 0, wait: async () => undefined,
    })).resolves.toEqual({ adapterCancelled: false, pidGone: false, processGone: false, markerAbsent: false });
    expect(remote.readFile).toHaveBeenCalledTimes(2);
    expect(remote.exec).toHaveBeenCalledTimes(2);
  });

  it("fails the probe when mandatory remote cleanup fails", async () => {
    let call = 0;
    const remote = {
      readFile: vi.fn(async () => { throw new Error("PID not written"); }),
      exec: vi.fn((request: ExecRequest) => {
        call += 1;
        if (call === 1) {
          return new Promise<ExecResult>((_resolve, reject) => request.signal!.addEventListener("abort", () => {
            reject(new CloudWorkspaceError("sandbox0", "cancelled", "cancelled during startup", "deferred"));
          }, { once: true }));
        }
        return Promise.resolve(result("cleanup failed", 1));
      }),
    };
    await expect(probeExactRemoteCancellation(remote, "cleanup-failure", {
      markerDelayMs: 1, startupPolls: 1, startupPollMs: 0, wait: async () => undefined,
    })).rejects.toThrow(/cleanup failed/);
  });

  it("allows signing only after exact independent PID, process, and marker absence", () => {
    const evidence = { adapterCancelled: true, pidGone: true, processGone: true, markerAbsent: true };
    const issue = vi.fn(() => ({ status: "PASS" as const }));
    expect(issueAfterExactRemoteCancellation(evidence, issue)).toEqual({ status: "PASS" });
    expect(issue).toHaveBeenCalledOnce();
  });
});
