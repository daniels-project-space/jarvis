import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const approvalToken = `${"a".repeat(64)}.${"b".repeat(43)}`;
const approvalMarker = `[JARVIS_ICLOUD_CALENDAR_APPROVAL:${approvalToken}]`;
const assistantRow = {
  _id: "icloud-approval-row",
  role: "assistant",
  text: `I prepared the iCloud Calendar event for your review.\n${approvalMarker}`,
  status: "done",
  delivery: "foreground" as const,
  createdAt: 1,
};
const viewer = vi.hoisted(() => ({ guest: false }));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    ui: {
      getActiveThread: { _name: "ui:getActiveThread" }, getThreads: { _name: "ui:getThreads" },
      getPanel: { _name: "ui:getPanel" }, getVoice: { _name: "ui:getVoice" },
      getLiveOn: { _name: "ui:getLiveOn" }, getStandbyListener: { _name: "ui:getStandbyListener" }, getHostAction: { _name: "ui:getHostAction" },
      getMood: { _name: "ui:getMood" }, getVideoCmd: { _name: "ui:getVideoCmd" },
    },
    chatQueue: {
      listMessages: { _name: "chatQueue:listMessages" }, listRecentMessages: { _name: "chatQueue:listRecentMessages" },
      paginatedMessages: { _name: "chatQueue:paginatedMessages" }, turnStatus: { _name: "chatQueue:turnStatus" },
    },
    files: { listForThread: { _name: "files:listForThread" } },
    creations: { list: { _name: "creations:list" } },
    projectState: { list: { _name: "projectState:list" } },
    googleAuth: { getConnectionStatus: { _name: "googleAuth:getConnectionStatus" } },
    commandCenter: { snapshot: { _name: "commandCenter:snapshot" }, fleetSnapshot: { _name: "commandCenter:fleetSnapshot" } },
    controllerSession: { status: { _name: "controllerSession:status" } },
    jobs: { detail: { _name: "jobs:detail" } },
    browserErrands: { pending: { _name: "browserErrands:pending" } },
  },
}));

vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (query: { _name?: string }) => {
    if (query?._name === "chatQueue:listMessages" || query?._name === "chatQueue:listRecentMessages") return [assistantRow];
    return undefined;
  },
}));
vi.mock("@/lib/viewer-session", () => ({
  useViewerSession: () => viewer.guest ? "guest.viewer.token" : "owner.viewer.token",
  isGuestViewerSession: () => viewer.guest,
}));
vi.mock("convex/react", () => ({ usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => <div data-orb-renderer /> }));

import JarvisUI from "./JarvisUI";

afterEach(() => {
  viewer.guest = false;
});

describe("iCloud Calendar approval message", () => {
  it("hides the signed receipt and renders the explicit owner approval control", () => {
    const markup = renderToStaticMarkup(<JarvisUI />);

    expect(markup).toContain("I prepared the iCloud Calendar event for your review.");
    expect(markup).toContain("data-icloud-calendar-approval");
    expect(markup).toContain("Approve iCloud event");
    expect(markup).toContain("Nothing changes until you click.");
    expect(markup).not.toContain(approvalMarker);
    expect(markup).not.toContain(approvalToken);
  });

  it("never renders the iCloud approval control for a guest session", () => {
    viewer.guest = true;
    const markup = renderToStaticMarkup(<JarvisUI />);

    expect(markup).not.toContain("data-icloud-calendar-approval");
    expect(markup).not.toContain("Approve iCloud event");
    expect(markup).not.toContain(approvalMarker);
  });
});
