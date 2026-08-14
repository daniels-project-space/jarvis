import { describe, expect, it } from "vitest";

import { novitaPatchProposalFailureClass } from "./novita-patch-proposal-receipt";

describe("Novita patch-proposal failure classification", () => {
  it("records an attested response-model mismatch as a response failure", () => {
    expect(novitaPatchProposalFailureClass("rejected", "response_model_mismatch")).toBe("response");
  });
});
