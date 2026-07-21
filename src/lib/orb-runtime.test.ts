import { describe, expect, it } from "vitest";
import { OrbRuntimeController, safeOrbSize, type OrbSurfaceMode } from "./orb-runtime";

function runtimeHarness() {
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const modes: OrbSurfaceMode[] = [];
  const controller = new OrbRuntimeController(
    (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    (handle) => {
      cancelled.push(handle);
      frames.delete(handle);
    },
    (mode) => modes.push(mode),
  );
  const runFrame = (timestamp: number) => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error("no scheduled frame");
    frames.delete(entry[0]);
    entry[1](timestamp);
  };
  return { controller, frames, cancelled, modes, runFrame };
}

describe("orb runtime lifecycle", () => {
  it("uses one RAF across construction fallback, context loss, and restoration", () => {
    const runtime = runtimeHarness();
    let published = 0;
    runtime.controller.start(() => published++);
    runtime.controller.start(() => published++);
    expect(runtime.frames.size).toBe(1);

    runtime.controller.useFallback();
    expect(runtime.controller.mode).toBe("fallback");
    runtime.runFrame(16);
    expect(published).toBe(1);
    expect(runtime.frames.size).toBe(1);

    runtime.controller.contextRestored();
    expect(runtime.controller.mode).toBe("restoring");
    runtime.controller.webglFrameReady();
    expect(runtime.controller.mode).toBe("webgl");
    expect(runtime.modes).toEqual(["fallback", "restoring", "webgl"]);
    expect(runtime.frames.size).toBe(1);
  });

  it("cleans one canvas, RAF, listeners, observers, and renderer resources exactly once", () => {
    const runtime = runtimeHarness();
    const listeners = new Map<string, EventListener>();
    const removed: string[] = [];
    const source = {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => {
        removed.push(type);
        listeners.delete(type);
      },
    };
    const children = new Set<Node>();
    const host = {
      appendChild: (node: Node) => { children.add(node); return node; },
      removeChild: (node: Node) => { children.delete(node); return node; },
    };
    const canvas = {} as Node;
    let observerDisconnects = 0;
    let resourceDisposals = 0;

    runtime.controller.mountCanvas(host, canvas);
    runtime.controller.mountCanvas(host, canvas);
    runtime.controller.listen(source, "resize", (() => undefined) as EventListener);
    runtime.controller.listen(source, "webglcontextlost", (() => undefined) as EventListener);
    runtime.controller.addCleanup(() => observerDisconnects++);
    runtime.controller.addCleanup(() => resourceDisposals++);
    runtime.controller.start(() => undefined);
    expect(children.size).toBe(1);
    expect(runtime.frames.size).toBe(1);
    expect(listeners.size).toBe(2);

    runtime.controller.dispose();
    runtime.controller.dispose();
    expect(children.size).toBe(0);
    expect(runtime.frames.size).toBe(0);
    expect(runtime.cancelled).toHaveLength(1);
    expect(removed.sort()).toEqual(["resize", "webglcontextlost"]);
    expect(observerDisconnects).toBe(1);
    expect(resourceDisposals).toBe(1);
  });

  it("never publishes a zero-size or stale-aspect resize", () => {
    expect(safeOrbSize(0, 0)).toEqual({ width: 1, height: 1, aspect: 1 });
    expect(safeOrbSize(1440.4, 1000.4)).toEqual({ width: 1440, height: 1000, aspect: 1.44 });
    expect(safeOrbSize(390, 844).aspect).toBeCloseTo(390 / 844, 12);
  });
});
