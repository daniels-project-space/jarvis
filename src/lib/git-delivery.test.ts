import { describe, expect, it } from "vitest";
import { gitDeliveryDisposition, isNonFastForwardPush } from "./git-delivery";

describe("durable Git delivery", () => {
  it("does not overwrite a shared branch that advanced while a no-op worker ran", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "base", remoteSha: "new-remote" }))
      .toBe("noop");
  });

  it("pushes a local commit only when the remote still matches its starting point", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local", remoteSha: "base" }))
      .toBe("push");
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local" })).toBe("push");
  });

  it("reconciles divergent local and remote progress before delivery", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local", remoteSha: "remote" }))
      .toBe("reconcile");
    expect(isNonFastForwardPush("! [rejected] HEAD -> branch (non-fast-forward)"))
      .toBe(true);
  });
});
