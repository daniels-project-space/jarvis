import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("convex/react", () => ({
  ConvexReactClient: class ConvexReactClient {},
  ConvexProviderWithAuth: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/convex-url", () => ({ resolveConvexUrl: () => "https://jarvis.test" }));
vi.mock("@/lib/viewer-session", () => ({
  ViewerSessionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ConvexAuthGate", () => ({
  ConvexAuthGate: ({ children }: { children: ReactNode }) => children,
}));

import Providers, { viewerRetryDelayMs } from "./providers";

describe("open owner provider boundary", () => {
  it("bootstraps every route without rendering a lock state", () => {
    const html = renderToStaticMarkup(<Providers><main>Private workspace</main></Providers>);
    expect(html).toContain("Initializing Jarvis");
    expect(html).not.toContain("Private workspace");
    expect(html).not.toMatch(/locked|pair/i);
  });

  it("backs off outages with bounded jitter instead of polling every few seconds forever", () => {
    expect(viewerRetryDelayMs(0, 0)).toBe(1_700);
    expect(viewerRetryDelayMs(1, 0.5)).toBe(4_000);
    expect(viewerRetryDelayMs(5, 1)).toBe(60_000);
    expect(viewerRetryDelayMs(50, 0)).toBe(51_000);
  });
});
