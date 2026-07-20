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
});
