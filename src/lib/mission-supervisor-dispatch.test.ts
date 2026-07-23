import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE,
  MISSION_SUPERVISOR_IDEMPOTENCY_KEY_TTL,
  MISSION_SUPERVISOR_TICK_TASK_ID,
  MissionSupervisorDispatchContractError,
  missionSupervisorDispatchIdentity,
  parseMissionSupervisorTickPayload,
  parseMissionSupervisorWakeTicket,
  type MissionSupervisorWakeTicket,
} from "./mission-supervisor-dispatch";

const ticket: MissionSupervisorWakeTicket = {
  protocolVersion: 1,
  missionId: "mission-supervisor-1",
  expectedLeaseVersion: 7,
  expectedEpoch: 3,
  expectedDecisionSequence: 11,
  expectedInputRevision: 19,
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("mission supervisor dispatch contract", () => {
  it("parses only the exact bounded wake-ticket shape", () => {
    expect(parseMissionSupervisorWakeTicket(ticket)).toEqual(ticket);
    expect(parseMissionSupervisorTickPayload(ticket)).toEqual(ticket);

    for (const malformed of [
      null,
      undefined,
      {},
      { ...ticket, protocolVersion: 2 },
      { ...ticket, missionId: "" },
      { ...ticket, missionId: `m${"x".repeat(160)}` },
      { ...ticket, missionId: "mission with spaces" },
      { ...ticket, expectedLeaseVersion: -1 },
      { ...ticket, expectedLeaseVersion: 1.5 },
      { ...ticket, expectedLeaseVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...ticket, expectedEpoch: 0 },
      { ...ticket, expectedDecisionSequence: 0 },
      { ...ticket, expectedInputRevision: -1 },
      { ...ticket, expectedInputRevision: "19" },
      { ...ticket, extra: "not-authority" },
    ]) {
      expect(() => parseMissionSupervisorWakeTicket(malformed))
        .toThrow(MissionSupervisorDispatchContractError);
    }
  });

  it("derives one stable global one-minute identity from every exact fence", () => {
    const identity = missionSupervisorDispatchIdentity(ticket);
    const material = [
      ticket.missionId,
      ticket.expectedEpoch,
      ticket.expectedDecisionSequence,
      ticket.expectedInputRevision,
      ticket.expectedLeaseVersion,
    ].join(":");
    const missionDigest = sha(ticket.missionId);
    expect(identity).toEqual({
      idempotencyKey: `mission-supervisor:${sha(material)}`,
      idempotencyKeyTTL: "1m",
      idempotencyKeyScope: "global",
      concurrencyKey: `mission-supervisor:${missionDigest.slice(0, 32)}`,
      tags: [
        "mission-supervisor",
        `mission:${missionDigest.slice(0, 24)}`,
      ],
    });
    expect(MISSION_SUPERVISOR_TICK_TASK_ID)
      .toBe("jarvis-mission-supervisor-tick");
    expect(MISSION_SUPERVISOR_IDEMPOTENCY_KEY_TTL).toBe("1m");
    expect(MISSION_SUPERVISOR_IDEMPOTENCY_KEY_SCOPE).toBe("global");
    expect(missionSupervisorDispatchIdentity({ ...ticket })).toEqual(identity);

    const variants = [
      { ...ticket, missionId: "mission-supervisor-2" },
      { ...ticket, expectedLeaseVersion: ticket.expectedLeaseVersion + 1 },
      { ...ticket, expectedEpoch: ticket.expectedEpoch + 1 },
      {
        ...ticket,
        expectedDecisionSequence: ticket.expectedDecisionSequence + 1,
      },
      { ...ticket, expectedInputRevision: ticket.expectedInputRevision + 1 },
    ];
    expect(new Set([
      identity.idempotencyKey,
      ...variants.map((value) =>
        missionSupervisorDispatchIdentity(value).idempotencyKey
      ),
    ]).size).toBe(variants.length + 1);
    for (const variant of variants.slice(1)) {
      expect(missionSupervisorDispatchIdentity(variant).concurrencyKey)
        .toBe(identity.concurrencyKey);
    }
  });

  it("is safe to import outside both Next and the Trigger task module", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        [
          "import('./src/lib/mission-supervisor-dispatch.ts').then((loaded) => {",
          "const module = loaded.default ?? loaded;",
          "if (!module.parseMissionSupervisorWakeTicket) process.exit(2);",
          "process.stdout.write(module.MISSION_SUPERVISOR_TICK_TASK_ID);",
          "})",
        ].join(""),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("jarvis-mission-supervisor-tick");
    expect(child.stderr).not.toContain("server-only");

    const source = readFileSync(
      new URL("./mission-supervisor-dispatch.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /server-only|@trigger\.dev|process\.env|randomBytes|randomUUID/,
    );
  });
});
