import { describe, expect, it, vi } from "vitest";
import {
  isClientChunkLoadError,
  loadClientChunk,
  recoverClientChunkLoad,
  recoverDynamicClientChunkLoad,
  type ClientChunkRecoveryRuntime,
} from "./client-chunk";

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
  it("recognizes Safari's dynamic-import rejection without matching generic failures", () => {
    expect(isClientChunkLoadError(new TypeError("Load failed"))).toBe(true);
    expect(isClientChunkLoadError(new TypeError("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isClientChunkLoadError(new Error("Load failed"))).toBe(false);
  });

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

  it("keeps a guarded React lazy loader pending while recovery reloads", async () => {
    const runtime = recoveryRuntime();
    const settled = vi.fn();
    const guarded = Promise.reject(new TypeError("Load failed")).catch((error) =>
      recoverDynamicClientChunkLoad(error, runtime),
    );

    void guarded.then(settled, settled);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.reload).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
  });

  it("leaves real module errors for React's error handling", async () => {
    const runtime = recoveryRuntime();
    const error = new Error("module initialization failed");

    await expect(recoverDynamicClientChunkLoad(error, runtime)).rejects.toBe(error);
    expect(runtime.reload).not.toHaveBeenCalled();
  });
});
