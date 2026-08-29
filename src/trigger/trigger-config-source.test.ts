import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { JARVIS_TRIGGER_ENV_KEYS } from "./trigger-env";

describe("Trigger mission rollout environment", () => {
  it("forwards the V2 mission protocol rollout consumed by Trigger workers", () => {
    const config = readFileSync(new URL("../../trigger.config.ts", import.meta.url), "utf8");
    const syncStart = config.indexOf("syncEnvVars(() =>");
    expect(syncStart).toBeGreaterThan(-1);
    expect(config.slice(syncStart)).toContain("syncedJarvisTriggerEnvironment(process.env)");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_MISSION_PROTOCOL_ROLLOUT");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_MISSION_SUPERVISOR_ROLLOUT");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_HUB_CONTEXT_TOKEN");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_HUB_ACTIONS_TOKEN");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_CLOUD_PROVIDER_PROBE");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_SELF_HOST_RUNNER_URL");
    expect(JARVIS_TRIGGER_ENV_KEYS).toContain("JARVIS_SELF_HOST_RUNNER_TOKEN");

    const runner = readFileSync(new URL("./agent-runner.ts", import.meta.url), "utf8");
    const foregroundTools = readFileSync(new URL("../lib/tools.ts", import.meta.url), "utf8");
    const rollout = readFileSync(new URL("../lib/mission-protocol-rollout.ts", import.meta.url), "utf8");
    expect(runner).toContain("v2AdmissionEnabled");
    expect(runner).toContain("admissionMutationName");
    expect(foregroundTools).toContain("v2AdmissionEnabled");
    expect(foregroundTools).toContain("admissionMutationName");
    expect(rollout).toContain("process.env.JARVIS_MISSION_PROTOCOL_ROLLOUT");
    expect(rollout).toContain("missionProtocolPhase()");
  });
});
