import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSubscriptionEnv, resolveSubscriptionAgentBin } from "./subscription-runtime";

describe("subscription subprocess capability scope", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("withholds dispatcher, worker and GitHub authority from specialists", () => {
    vi.stubEnv("JARVIS_CLAUDE_HOME", "/tmp/jarvis-test-claude-home");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "subscription-token");
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("GITHUB_TOKEN", "github-capability");
    const specialist = prepareSubscriptionEnv("claude").env;
    expect(specialist.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(specialist.JARVIS_WORKER_TOKEN).toBeUndefined();
    expect(specialist.GITHUB_TOKEN).toBeUndefined();
  });

  it("grants only the narrow dispatcher to the conversational supervisor", () => {
    vi.stubEnv("JARVIS_CLAUDE_HOME", "/tmp/jarvis-test-claude-home");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "subscription-token");
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const supervisor = prepareSubscriptionEnv("claude", { includeDispatch: true }).env;
    expect(supervisor.JARVIS_DISPATCH_TOKEN).toBe("dispatch-capability");
    expect(supervisor.JARVIS_WORKER_TOKEN).toBeUndefined();
  });

  it("ships the pinned Codex CLI that Trigger conversation workers resolve", () => {
    expect(resolveSubscriptionAgentBin("codex")).toMatch(/codex/);
  });
});
