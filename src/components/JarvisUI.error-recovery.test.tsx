import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { foregroundTurnPhase, terminalDurableRecoveryOutcome } from "@/lib/foreground-recovery";

// A durable turn whose assistant reply was finalized as "error" by the
// backend (chatQueue.ts's finalize({status:"error"}), recoverAssistant,
// expirePending, or issueRecoveryWake) — the exact shape that once left the
// Jarvis overlay stuck showing "thinking" forever.
const erroredAssistantRow = {
  _id: "assistant-errored-row",
  role: "assistant",
  text: "That reply hit a technical problem.",
  status: "error",
  delivery: "foreground" as const,
  createdAt: 2,
  parentMessageId: "user-turn-1",
};
const pendingUserRow = {
  _id: "user-turn-1",
  role: "user",
  text: "keep going",
  status: "done",
  delivery: "foreground" as const,
  createdAt: 1,
  parentMessageId: undefined as string | undefined,
};

vi.mock("../../convex/_generated/api", () => ({
  api: {
    ui: {
      getActiveThread: { _name: "ui:getActiveThread" }, getThreads: { _name: "ui:getThreads" },
      getPanel: { _name: "ui:getPanel" }, getVoice: { _name: "ui:getVoice" },
      getLiveOn: { _name: "ui:getLiveOn" }, getHostAction: { _name: "ui:getHostAction" },
      getMood: { _name: "ui:getMood" }, getVideoCmd: { _name: "ui:getVideoCmd" },
    },
    chatQueue: {
      listMessages: { _name: "chatQueue:listMessages" }, listRecentMessages: { _name: "chatQueue:listRecentMessages" },
      paginatedMessages: { _name: "chatQueue:paginatedMessages" },
      turnStatus: { _name: "chatQueue:turnStatus" },
    },
    commandCenter: { snapshot: { _name: "commandCenter:snapshot" } },
    controllerSession: { status: { _name: "controllerSession:status" } },
    jobs: { detail: { _name: "jobs:detail" } },
    browserErrands: { pending: { _name: "browserErrands:pending" } },
  },
}));

vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (query: { _name?: string }) => {
    if (query?._name === "chatQueue:listMessages" || query?._name === "chatQueue:listRecentMessages") {
      return [pendingUserRow, erroredAssistantRow];
    }
    return undefined;
  },
}));
vi.mock("@/lib/viewer-session", () => ({
  useViewerSession: () => "owner.viewer.token",
  isGuestViewerSession: () => false,
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({
  default: () => () => <div data-orb-renderer />,
}));

import JarvisUI from "./JarvisUI";

describe("terminal-message effect: error phase releases the composer", () => {
  it("renders without throwing for a thread whose latest turn was finalized as an error", () => {
    // Smoke-render JarvisUI (embedded, matching JarvisUI.guest-render.test.tsx's
    // working render convention) with the same error-finalized message set the
    // durable-recovery effect watches. This does not execute effects (SSR
    // never runs useEffect), so it only proves the component tolerates this
    // state — the load-bearing assertion is below.
    expect(() => renderToStaticMarkup(<JarvisUI embedded />)).not.toThrow();
  });

  it("resolves sending to false instead of leaving the UI stuck on 'thinking' (regression for the inverted error branch)", () => {
    // This mirrors exactly what JarvisUI's terminal-message effect does at
    // runtime: derive the phase for the tracked turn from the message list
    // via foregroundTurnPhase, then feed that phase into
    // terminalDurableRecoveryOutcome — the same two functions JarvisUI.tsx
    // imports from "@/lib/foreground-recovery" and calls in the effect.
    const messages = [pendingUserRow, erroredAssistantRow].map((message) => ({
      id: message._id,
      role: message.role,
      status: message.status,
      text: message.text,
      parentMessageId: message.parentMessageId,
    }));

    const { phase } = foregroundTurnPhase(messages, "user-turn-1");
    expect(phase).toBe("error");

    const outcome = terminalDurableRecoveryOutcome(phase);
    expect(outcome).not.toBeNull();
    // Before the fix this was `sending: true` with clearActiveTurn never
    // applied, which is exactly what stranded the overlay on "thinking".
    expect(outcome?.sending).toBe(false);
    expect(outcome?.clearActiveTurn).toBe(true);
    expect(outcome?.durableRecovery).toBe("failed");
  });
});
