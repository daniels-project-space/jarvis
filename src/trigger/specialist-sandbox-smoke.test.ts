import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exactSandboxObservationPassed } from "./specialist-sandbox-smoke";

const safeObservation = {
  readSucceeded: true,
  workspaceWriteSucceeded: true,
  outsideWriteBlocked: true,
  curlBlocked: true,
  socketBlocked: true,
  procCredentialVisible: false,
  credentialFileVisible: false,
  namespaceProcSafe: true,
  applyPatchSucceeded: true,
  noSecretEchoed: true,
  namespaceLifecycleSafe: true,
  tools: { node: true, npm: true, npx: true, git: true, gh: true, curl: true },
};

describe("deployed specialist adversarial receipt", () => {
  it("requires workspace/tool utility while denying network, proc and filesystem credentials", () => {
    expect(exactSandboxObservationPassed(safeObservation)).toBe(true);
    for (const unsafe of [
      { procCredentialVisible: true },
      { credentialFileVisible: true },
      { outsideWriteBlocked: false },
      { curlBlocked: false },
      { socketBlocked: false },
      { namespaceProcSafe: false },
      { applyPatchSucceeded: false },
      { noSecretEchoed: false },
      { namespaceLifecycleSafe: false },
      { tools: { ...safeObservation.tools, git: false } },
    ]) {
      expect(exactSandboxObservationPassed({ ...safeObservation, ...unsafe }), JSON.stringify(unsafe)).toBe(false);
    }
  });

  it("returns providerCommandSandbox only after the deployed synthetic-checkout lifecycle gate passes", () => {
    const source = readFileSync(join(process.cwd(), "src/trigger/specialist-sandbox-smoke.ts"), "utf8");
    const gate = source.indexOf("const provider = await runProviderCommandSandboxSmoke()");
    const rejection = source.indexOf("if (!provider.ok) throw new Error(provider.reason)");
    const receipt = source.indexOf("providerCommandSandbox: true as const");
    expect(gate).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(gate);
    expect(receipt).toBeGreaterThan(rejection);
    expect(source).toContain("verifyProviderSandboxLifecycle(sandbox)");
    expect(source).toContain("synthetic sandbox fixture");
  });
});
