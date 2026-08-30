import { describe, expect, it } from "vitest";
import {
  foregroundDispatchFailure,
  foregroundDispatchMode,
  freshSelfHostedForegroundLease,
} from "./foreground-runner-mode";

const now = 1_800_000;

describe("foreground runner selection", () => {
  it("uses Trigger normally and preserves its explicit billing hold", () => {
    expect(foregroundDispatchMode({}, null, now)).toBe("trigger");
    expect(foregroundDispatchMode({
      JARVIS_FOREGROUND_HOLD_REASON: "trigger_billing_limit",
    }, null, now)).toBe("billing_paused");
    expect(foregroundDispatchFailure("billing_paused")).toMatchObject({
      code: "FOREGROUND_WORKERS_BILLING_PAUSED",
    });
  });

  it("requires an exact fresh self-hosted lease before bypassing Trigger", () => {
    const env = { JARVIS_SELF_HOSTED_FOREGROUND: "live" };
    const lease = { runnerId: "selfhost:mac-studio:primary:run-1", updatedAt: now - 5_000 };
    expect(freshSelfHostedForegroundLease(lease, now)).toBe(true);
    expect(foregroundDispatchMode(env, lease, now)).toBe("selfhost");
    expect(foregroundDispatchMode(env, { ...lease, updatedAt: now - 25_000 }, now)).toBe("selfhost_unavailable");
    expect(foregroundDispatchMode(env, { runnerId: "trigger:primary:run-1", updatedAt: now - 1 }, now)).toBe("selfhost_unavailable");
    expect(foregroundDispatchMode(env, { ...lease, updatedAt: now + 1 }, now)).toBe("selfhost_unavailable");
    expect(foregroundDispatchFailure("selfhost_unavailable")).toMatchObject({
      code: "SELF_HOSTED_FOREGROUND_OFFLINE",
    });
  });

  it("never falls back to paid Trigger when self-host mode was explicitly selected", () => {
    expect(foregroundDispatchMode({
      JARVIS_SELF_HOSTED_FOREGROUND: "live",
      JARVIS_FOREGROUND_HOLD_REASON: "trigger_billing_limit",
    }, null, now)).toBe("selfhost_unavailable");
  });
});
