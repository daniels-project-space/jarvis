import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Trigger mission rollout environment", () => {
  it("forwards the V2 mission protocol rollout consumed by Trigger workers", () => {
    const config = readFileSync(new URL("../../trigger.config.ts", import.meta.url), "utf8");
    const syncStart = config.indexOf("syncEnvVars(() =>");
    const syncEnd = config.indexOf("return Object.keys(values)", syncStart);
    expect(syncStart).toBeGreaterThan(-1);
    expect(syncEnd).toBeGreaterThan(syncStart);

    const syncedEnvironment = config.slice(syncStart, syncEnd);
    expect(syncedEnvironment).toContain('"JARVIS_MISSION_PROTOCOL_ROLLOUT"');
    expect(syncedEnvironment).toContain('"JARVIS_MISSION_SUPERVISOR_ROLLOUT"');

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
