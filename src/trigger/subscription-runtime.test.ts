import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSubscriptionEnv, resolveSubscriptionAgentBin } from "./subscription-runtime";

describe("subscription subprocess capability scope", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("withholds dispatcher, worker and GitHub authority from specialists", () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("GITHUB_TOKEN", "github-capability");
    const specialist = prepareSubscriptionEnv("codex").env;
    expect(specialist.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(specialist.JARVIS_WORKER_TOKEN).toBeUndefined();
    expect(specialist.GITHUB_TOKEN).toBeUndefined();
  });

  it("keeps bridge authentication in the Trigger host instead of every Codex child", () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const supervisor = prepareSubscriptionEnv("codex").env;
    expect(supervisor.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(supervisor.JARVIS_WORKER_TOKEN).toBeUndefined();
  });

  it("ships the pinned Codex CLI that Trigger conversation workers resolve", () => {
    expect(resolveSubscriptionAgentBin("codex")).toMatch(/codex/);
  });
});
