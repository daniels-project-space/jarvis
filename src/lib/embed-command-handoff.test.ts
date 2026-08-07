import { describe, expect, it } from "vitest";
import {
  reconcileEmbeddedThreadReadiness,
  stableEmbeddedActorKey,
  type EmbeddedThreadContext,
} from "./embed-command-handoff";

function viewerToken(claims: Record<string, unknown>, signature: string): string {
  return `header.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${signature}`;
}

describe("embedded thread command handoff", () => {
  it("closes the ready gate during rehydration and keeps the command for the resolved thread", () => {
    const readyMain: EmbeddedThreadContext = {
      actorKey: "hub|actor-a",
      threadId: "main",
      hydrated: true,
    };
    const pending: EmbeddedThreadContext = {
      actorKey: "hub|actor-a",
      threadId: null,
      hydrated: false,
    };
    const waiting = reconcileEmbeddedThreadReadiness(readyMain, pending, true);
    expect(waiting).toEqual({ ready: false, discardPending: false });

    const resolved: EmbeddedThreadContext = {
      actorKey: "hub|actor-a",
      threadId: "project-thread",
      hydrated: true,
    };
    expect(reconcileEmbeddedThreadReadiness(pending, resolved, waiting.ready)).toEqual({
      ready: false,
      discardPending: false,
    });
  });

  it("discards commands captured for a different embed origin or actor", () => {
    expect(reconcileEmbeddedThreadReadiness({
      actorKey: "hub-a|actor-a",
      threadId: "main",
      hydrated: true,
    }, {
      actorKey: "hub-b|actor-b",
      threadId: "main",
      hydrated: true,
    }, true)).toEqual({ ready: false, discardPending: true });
  });

  it("retains a queued command when the same validated actor receives a refreshed token", () => {
    const claims = { project: "jarvis", role: "owner", sub: "daniel-owner" };
    const beforeRefresh = stableEmbeddedActorKey(
      "https://project-hub.test",
      viewerToken({ ...claims, iat: 100, exp: 200 }, "old-signature"),
    );
    const afterRefresh = stableEmbeddedActorKey(
      "https://project-hub.test",
      viewerToken({ ...claims, iat: 150, exp: 250 }, "new-signature"),
    );
    expect(afterRefresh).toBe(beforeRefresh);

    const waiting: EmbeddedThreadContext = {
      actorKey: beforeRefresh,
      threadId: null,
      hydrated: false,
    };
    const hydrated: EmbeddedThreadContext = {
      actorKey: afterRefresh,
      threadId: "project-thread",
      hydrated: true,
    };
    expect(reconcileEmbeddedThreadReadiness(waiting, hydrated, false)).toEqual({
      ready: false,
      discardPending: false,
    });
  });
});
