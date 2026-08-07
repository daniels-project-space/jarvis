import { describe, expect, it } from "vitest";
import {
  assertProductionRuntimeConfig,
  missingProductionRuntimeConfig,
} from "./production-runtime-config";

const completeProductionEnvironment = {
  VERCEL_ENV: "production",
  NEXT_PUBLIC_CONVEX_URL: "https://example.convex.cloud",
  JARVIS_DISPATCH_TOKEN: "dispatch",
  JARVIS_WORKER_TOKEN: "worker",
  JARVIS_VIEWER_SIGNING_JWK_B64: "jwk",
  TRIGGER_SECRET_KEY: "trigger",
  VAULT_ACCESS_TOKEN: "vault",
  JARVIS_PRIVATE_R2_BUCKET: "jarvis-private-files",
};

describe("production runtime configuration", () => {
  it("allows complete production configuration", () => {
    expect(missingProductionRuntimeConfig(completeProductionEnvironment)).toEqual([]);
    expect(() => assertProductionRuntimeConfig(completeProductionEnvironment)).not.toThrow();
  });

  it("treats empty and whitespace-only production secrets as missing", () => {
    const environment = {
      ...completeProductionEnvironment,
      TRIGGER_SECRET_KEY: "",
      VAULT_ACCESS_TOKEN: "   ",
    };

    expect(missingProductionRuntimeConfig(environment)).toEqual([
      "TRIGGER_SECRET_KEY",
      "VAULT_ACCESS_TOKEN",
    ]);
    expect(() => assertProductionRuntimeConfig(environment)).toThrow(
      "TRIGGER_SECRET_KEY, VAULT_ACCESS_TOKEN",
    );
  });

  it("does not require production-only secrets in local or preview builds", () => {
    expect(missingProductionRuntimeConfig({ VERCEL_ENV: "preview" })).toEqual([]);
    expect(missingProductionRuntimeConfig({ NODE_ENV: "production" })).toEqual([]);
  });
});
