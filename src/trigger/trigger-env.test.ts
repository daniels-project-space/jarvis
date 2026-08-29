import { describe, expect, it } from "vitest";

import {
  CODEX_SESSION_SOURCE,
  CODEX_SESSION_SOURCE_ENV,
  syncedJarvisTriggerEnvironment,
} from "./trigger-env";

describe("Trigger environment allowlist", () => {
  it("supplies the safe Vault-broker selector when the host omitted it", () => {
    expect(syncedJarvisTriggerEnvironment({
      JARVIS_WORKER_TOKEN: "worker-token",
    })).toEqual({
      JARVIS_WORKER_TOKEN: "worker-token",
      [CODEX_SESSION_SOURCE_ENV]: CODEX_SESSION_SOURCE,
    });
  });

  it("preserves an explicitly supplied source selector and never invents credentials", () => {
    expect(syncedJarvisTriggerEnvironment({
      [CODEX_SESSION_SOURCE_ENV]: "explicit-source",
      VAULT_ACCESS_TOKEN: "vault-token",
      UNRELATED_SECRET: "must-not-leak",
    })).toEqual({
      VAULT_ACCESS_TOKEN: "vault-token",
      [CODEX_SESSION_SOURCE_ENV]: "explicit-source",
    });
  });
});
