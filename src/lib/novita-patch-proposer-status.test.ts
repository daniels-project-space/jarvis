import { describe, expect, it } from "vitest";

import { novitaPatchProposerStatusPresentation } from "./novita-patch-proposer-status";

describe("Novita patch-proposer status presentation", () => {
  it("explains disabled state without implying a credential or endpoint is read", () => {
    expect(novitaPatchProposerStatusPresentation("attestation_not_configured")).toMatchObject({
      label: "disabled",
      tone: "attention",
      hint: expect.stringContaining("will not schedule or contact"),
    });
    expect(novitaPatchProposerStatusPresentation("attestation_ready")).toMatchObject({
      label: "attested ✓",
      tone: "ready",
      hint: expect.stringContaining("credential stays sealed"),
    });
  });
});
