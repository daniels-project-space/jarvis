import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ usePathname: vi.fn(() => "/pair") }));

vi.mock("next/navigation", () => ({ usePathname: mock.usePathname }));
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

import Providers from "./providers";

describe("owner pairing provider boundary", () => {
  it("renders the pairing page before an owner viewer session exists", () => {
    mock.usePathname.mockReturnValue("/pair");
    const html = renderToStaticMarkup(<Providers><main>Pair this owner browser</main></Providers>);
    expect(html).toContain("Pair this owner browser");
    expect(html).not.toContain("Initializing Jarvis");
  });

  it("keeps ordinary routes behind the owner viewer bootstrap", () => {
    mock.usePathname.mockReturnValue("/");
    const html = renderToStaticMarkup(<Providers><main>Private workspace</main></Providers>);
    expect(html).toContain("Initializing Jarvis");
    expect(html).not.toContain("Private workspace");
  });
});
