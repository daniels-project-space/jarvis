import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isLoading: true, isAuthenticated: false }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
}));

import { ConvexAuthGate } from "./ConvexAuthGate";

describe("ConvexAuthGate", () => {
  beforeEach(() => {
    auth.isLoading = true;
    auth.isAuthenticated = false;
  });

  it("does not mount protected queries before the Convex JWT handshake", () => {
    const pending = renderToStaticMarkup(<ConvexAuthGate><div>protected-chat</div></ConvexAuthGate>);
    expect(pending).not.toContain("protected-chat");

    auth.isLoading = false;
    auth.isAuthenticated = true;
    const ready = renderToStaticMarkup(<ConvexAuthGate><div>protected-chat</div></ConvexAuthGate>);
    expect(ready).toContain("protected-chat");
  });
});
