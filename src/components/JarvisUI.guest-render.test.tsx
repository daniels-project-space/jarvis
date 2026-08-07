import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const legacyGuestRow = {
  _id: "legacy-guest-row",
  role: "assistant",
  text: "This text remains visible to the guest.",
  status: "done",
  delivery: "foreground" as const,
  createdAt: 1,
  attachment: { type: "image", value: "r2://owner-only-frame", title: "owner-only legacy card" },
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
    jobs: { detail: { _name: "jobs:detail" } },
  },
}));

vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (query: { _name?: string }) => {
    if (query?._name === "chatQueue:listMessages" || query?._name === "chatQueue:listRecentMessages") return [legacyGuestRow];
    return undefined;
  },
}));
vi.mock("@/lib/viewer-session", () => ({
  useViewerSession: () => "guest.viewer.token",
  isGuestViewerSession: () => true,
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({
  default: () => () => <div data-orb-renderer />,
}));

import Home from "../app/page";
import JarvisUI from "./JarvisUI";

describe("guest Home application render", () => {
  it("keeps text visible while suppressing a legacy persistent card in the actual page tree", () => {
    const markup = renderToStaticMarkup(<Home />);

    expect(markup).toContain("This text remains visible to the guest.");
    expect(markup).toContain('id="jarvis-attachment-trigger"');
    expect(markup).toContain('aria-label="Attach files — connect owner tools"');
    expect(markup).toContain('data-jarvis-attachment-access="guest-locked"');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Saved files");
    expect(markup).not.toContain("owner-only legacy card");
    expect(markup).not.toContain("r2://owner-only-frame");
    expect(markup).not.toContain('src="r2://owner-only-frame"');
  });

  it("server-renders an untrusted embed as locked with a dependable close control", () => {
    const markup = renderToStaticMarkup(<JarvisUI embedded />);

    expect(markup).toContain("Connecting Jarvis…");
    expect(markup).toContain('aria-label="Close Jarvis"');
    expect(markup).not.toContain("This text remains visible to the guest.");
  });
});
