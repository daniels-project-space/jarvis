import { afterEach, describe, expect, it, vi } from "vitest";
import {
  missingSubscriptionTools,
  prepareSubscriptionEnv,
  REQUIRED_AGENT_TOOLS,
  resolveSubscriptionAgentBin,
} from "./subscription-runtime";

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
    expect(specialist.GH_TOKEN).toBeUndefined();
  });

  it("preserves the executable and network runtime without passing application authority", () => {
    vi.stubEnv("PATH", process.env.PATH ?? "/usr/bin:/bin");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.internal:8080");
    vi.stubEnv("CODEX_ACCESS_TOKEN", "subscription-token");
    const specialist = prepareSubscriptionEnv("codex").env;
    expect(specialist.PATH).toBe(process.env.PATH);
    expect(specialist.HTTPS_PROXY).toBe("http://proxy.internal:8080");
    expect(specialist.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("finds every required specialist binary on the worker PATH", () => {
    expect(missingSubscriptionTools(process.env, REQUIRED_AGENT_TOOLS)).toEqual([]);
  });

  it("reports an honest missing-tool list for an over-sanitized PATH", () => {
    expect(missingSubscriptionTools({ PATH: "/definitely/missing" }, ["curl", "git"])).toEqual(["curl", "git"]);
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
