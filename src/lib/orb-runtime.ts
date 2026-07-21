export type OrbSurfaceMode = "webgl" | "fallback" | "restoring";

type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (handle: number) => void;
type EventSource = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};
type CanvasHost = {
  appendChild(node: Node): Node;
  removeChild(node: Node): Node;
};

// Owns the one scheduled orb frame and every imperative resource attached by
// ThreeOrb. It is deliberately DOM-light so construction failure and cleanup
// can be proven with deterministic fakes in the node test environment.
export class OrbRuntimeController {
  private frameHandle: number | null = null;
  private frameCallback: FrameRequestCallback | null = null;
  private cleanups: Array<() => void> = [];
  private canvas: { host: CanvasHost; node: Node } | null = null;
  private disposed = false;
  private currentMode: OrbSurfaceMode = "webgl";
  private readonly tick: FrameRequestCallback = (timestamp) => {
    this.frameHandle = null;
    if (this.disposed || !this.frameCallback) return;
    try {
      this.frameCallback(timestamp);
    } finally {
      this.schedule();
    }
  };

  constructor(
    private readonly requestFrame: FrameRequest,
    private readonly cancelFrame: FrameCancel,
    private readonly onMode: (mode: OrbSurfaceMode) => void,
  ) {}

  get mode(): OrbSurfaceMode {
    return this.currentMode;
  }

  start(callback: FrameRequestCallback): void {
    this.frameCallback = callback;
    this.schedule();
  }

  private schedule(): void {
    if (!this.disposed && this.frameCallback && this.frameHandle === null) {
      this.frameHandle = this.requestFrame(this.tick);
    }
  }

  useFallback(): void {
    this.setMode("fallback");
  }

  contextRestored(): void {
    if (this.currentMode === "fallback") this.setMode("restoring");
  }

  webglFrameReady(): void {
    if (this.currentMode === "restoring") this.setMode("webgl");
  }

  private setMode(mode: OrbSurfaceMode): void {
    if (this.disposed || mode === this.currentMode) return;
    this.currentMode = mode;
    this.onMode(mode);
  }

  listen(source: EventSource, type: string, listener: EventListener): void {
    if (this.disposed) return;
    source.addEventListener(type, listener);
    this.cleanups.push(() => source.removeEventListener(type, listener));
  }

  addCleanup(cleanup: () => void): void {
    if (this.disposed) cleanup();
    else this.cleanups.push(cleanup);
  }

  mountCanvas(host: CanvasHost, node: Node): void {
    if (this.disposed || this.canvas?.node === node) return;
    if (this.canvas) this.canvas.host.removeChild(this.canvas.node);
    host.appendChild(node);
    this.canvas = { host, node };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    if (this.canvas) this.canvas.host.removeChild(this.canvas.node);
    this.canvas = null;
    this.frameCallback = null;
  }
}

export function safeOrbSize(width: number, height: number): { width: number; height: number; aspect: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return { width: safeWidth, height: safeHeight, aspect: safeWidth / safeHeight };
}
