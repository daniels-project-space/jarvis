import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hubContextReadiness, hubContextRequestArgs } from "./hub-context";

afterEach(() => vi.unstubAllEnvs());

describe("Project Hub context capability", () => {
  it("uses the dedicated capability and never falls back to the broad vault credential", () => {
    const environment = {
      JARVIS_HUB_CONTEXT_TOKEN: " dedicated-jarvis-context-token ",
      VAULT_ACCESS_TOKEN: "broad-vault-token-must-not-be-used",
    };

    expect(hubContextRequestArgs(environment)).toEqual({ vaultToken: "dedicated-jarvis-context-token" });
    expect(hubContextReadiness(environment)).toEqual({ configured: true });
  });

  it("fails closed when the dedicated capability is absent or blank", () => {
    expect(hubContextRequestArgs({ VAULT_ACCESS_TOKEN: "broad-vault-token-must-not-be-used" })).toBeNull();
    expect(hubContextRequestArgs({ JARVIS_HUB_CONTEXT_TOKEN: "   " })).toBeNull();
    expect(hubContextReadiness({ JARVIS_HUB_CONTEXT_TOKEN: "   " })).toEqual({ configured: false });
  });
});
