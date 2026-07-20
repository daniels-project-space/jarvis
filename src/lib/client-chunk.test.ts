import { describe, expect, it, vi } from "vitest";
import { loadClientChunk, recoverClientChunkLoad, type ClientChunkRecoveryRuntime } from "./client-chunk";

function recoveryRuntime(now = 20_000, last = "0") {
  const runtime: ClientChunkRecoveryRuntime = {
    now: () => now,
    readReloadAt: vi.fn(() => last),
    writeReloadAt: vi.fn(),
    recordFailure: vi.fn(),
    reload: vi.fn(),
  };
  return runtime;
}

describe("client chunk recovery", () => {
  it("reloads once and records a contextual dynamic-import failure", () => {
    const runtime = recoveryRuntime();

    recoverClientChunkLoad(new TypeError("Load failed"), runtime);

    expect(runtime.recordFailure).toHaveBeenCalledWith("TypeError: Load failed");
    expect(runtime.writeReloadAt).toHaveBeenCalledWith("20000");
    expect(runtime.reload).toHaveBeenCalledOnce();
  });

  it("does not enter a reload loop when the replacement chunk also fails", () => {
    const runtime = recoveryRuntime(25_000, "20000");

    recoverClientChunkLoad(new TypeError("Load failed"), runtime);

    expect(runtime.recordFailure).toHaveBeenCalledOnce();
    expect(runtime.writeReloadAt).not.toHaveBeenCalled();
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it("resolves a rejected module request to a safe fallback", async () => {
    await expect(loadClientChunk(() => Promise.resolve({ ready: true }))).resolves.toEqual({ ready: true });
    await expect(loadClientChunk(() => Promise.reject(new TypeError("Load failed")))).resolves.toBeNull();
  });
});
