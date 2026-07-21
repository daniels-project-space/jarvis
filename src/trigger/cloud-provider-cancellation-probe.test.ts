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
  });

  it("allows signing only after exact independent PID, process, and marker absence", () => {
    const evidence = { adapterCancelled: true, pidGone: true, processGone: true, markerAbsent: true };
    const issue = vi.fn(() => ({ status: "PASS" as const }));
    expect(issueAfterExactRemoteCancellation(evidence, issue)).toEqual({ status: "PASS" });
    expect(issue).toHaveBeenCalledOnce();
  });
});
