import { describe, expect, it } from "vitest";
import { SubscriptionSessionError } from "./subscription-session";
import {
  CODEX_SESSION_SOURCE,
  CODEX_SESSION_SOURCE_ENV,
  environmentWithoutSubscriptionController,
  requireVaultBrokerSubscriptionSource,
} from "./subscription-source";

describe("Codex subscription source boundary", () => {
  it("requires the explicit vault broker selector", () => {
    expect(() => requireVaultBrokerSubscriptionSource({
      [CODEX_SESSION_SOURCE_ENV]: CODEX_SESSION_SOURCE,
    })).not.toThrow();
    for (const source of [undefined, "vault", "environment", "copied-auth-json"]) {
      let error: unknown;
      try {
        requireVaultBrokerSubscriptionSource({ [CODEX_SESSION_SOURCE_ENV]: source });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SubscriptionSessionError);
      expect(error).toMatchObject({ code: "source_rejected" });
    }
  });

  it("rejects controller names before reading their values", () => {
    const reads: string[] = [];
    const source = {} as Record<string, string | undefined>;
    for (const [name, value] of [
      ["PATH", "/usr/bin"],
      ["CODEX_AUTH_JSON_B64", "never-read-auth"],
      ["CODEX_HOME", "/controller/session/home"],
      ["HOME", "/controller/home"],
      ["XDG_CONFIG_HOME", "/controller/config"],
      ["R2_PARENT_API_TOKEN", "never-read-parent"],
      ["R2_PARENT_ACCESS_KEY_ID", "never-read-parent-id"],
      ["AWS_SESSION_TOKEN", "never-read-session"],
      ["VAULT_ACCESS_TOKEN", "never-read-vault"],
      [CODEX_SESSION_SOURCE_ENV, CODEX_SESSION_SOURCE],
    ] as const) {
      Object.defineProperty(source, name, {
        enumerable: true,
        get: () => { reads.push(name); return value; },
      });
    }

    expect(environmentWithoutSubscriptionController(source)).toEqual({ PATH: "/usr/bin" });
    expect(reads).toEqual(["PATH"]);
  });
});
