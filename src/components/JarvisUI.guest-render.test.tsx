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
const queryTrace = vi.hoisted(() => ({
  calls: [] as Array<{ name?: string; args: unknown }>,
}));

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
    creations: { list: { _name: "creations:list" } },
    files: { quickSearchLibrary: { _name: "files:quickSearchLibrary" } },
    memory: { quickSearch: { _name: "memory:quickSearch" } },
    projectState: { list: { _name: "projectState:list" } },
    commandCenter: { snapshot: { _name: "commandCenter:snapshot" } },
    controllerSession: { status: { _name: "controllerSession:status" } },
    jobs: { detail: { _name: "jobs:detail" } },
    browserErrands: { pending: { _name: "browserErrands:pending" } },
  },
}));

vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (query: { _name?: string }, args: unknown) => {
    queryTrace.calls.push({ name: query?._name, args });
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
import JarvisUI, { activeVoiceActionSurface, MessageFileBadges, safeEmbeddedMessageText, Viewport, voiceActionPresentation } from "./JarvisUI";

describe("guest Home application render", () => {
  it("uses one stateful voice action instead of competing live and microphone controls", () => {
    expect(voiceActionPresentation({ live: "off", recording: false, speaking: false })).toMatchObject({
      action: "toggle-live", ariaLabel: "Start Jarvis live listening", label: "voice",
    });
    expect(voiceActionPresentation({ live: "off", recording: false, speaking: false, wakeReady: true })).toMatchObject({
      action: "toggle-live", label: "wake-only", glyph: "◇",
    });
    expect(voiceActionPresentation({ live: "connecting", recording: false, speaking: false })).toMatchObject({
      action: "toggle-live", ariaLabel: "Cancel Jarvis voice connection", label: "connecting",
    });
    expect(voiceActionPresentation({ live: "live", recording: false, speaking: false })).toMatchObject({
      action: "toggle-live", ariaLabel: "Stop Jarvis live listening", label: "listening",
    });
    expect(voiceActionPresentation({ live: "off", recording: true, speaking: false })).toMatchObject({
      action: "finish-recording", ariaLabel: "Finish recording your voice message",
    });
    expect(voiceActionPresentation({ live: "live", recording: false, speaking: true })).toMatchObject({
      action: "interrupt", ariaLabel: "Interrupt Jarvis", label: "hush",
    });
    expect(activeVoiceActionSurface({ embedded: true, chatMode: "bar" })).toBe("embedded");
    expect(activeVoiceActionSurface({ embedded: false, chatMode: "full" })).toBe("full");
    expect(activeVoiceActionSurface({ embedded: false, chatMode: "bar" })).toBe("bar");
    expect(activeVoiceActionSurface({ embedded: false, chatMode: "off" })).toBeNull();
  });

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

  it("server-renders an unresolved embed as an accessible mini orb that opens the full assistant", () => {
    queryTrace.calls = [];
    const markup = renderToStaticMarkup(<JarvisUI embedded />);

    expect(markup).toContain("data-jarvis-embed-surface");
    expect(markup).toContain("data-jarvis-mini-orb");
    expect(markup).toContain('aria-label="Open Jarvis. online."');
    expect(markup).toContain("Focus, hover, or activate the orb");
    expect(markup).not.toMatch(/locked|pairing/i);
    expect(queryTrace.calls).toContainEqual({
      name: "chatQueue:listRecentMessages",
      args: { threadId: "main" },
    });
  });

  it("replaces raw operational logs with a concise recoverable embed message", () => {
    expect(safeEmbeddedMessageText({
      role: "assistant",
      status: "error",
      text: "⚠️ TypeError: upstream timed out\n    at worker (/srv/agent.ts:42:7)\nstderr: request failed",
    })).toBe("That reply hit a technical problem. Use recover or retry.");

    expect(safeEmbeddedMessageText({
      role: "assistant",
      status: "streaming",
      text: "src/worker.ts(42,7): error TS2322: internal compiler detail",
    })).toBe("That reply hit a technical problem. Use recover or retry.");

    expect(safeEmbeddedMessageText({
      role: "assistant",
      status: "done",
      text: "I saved the useful result.\nstderr: noisy implementation detail",
    })).toBe("I saved the useful result.");
  });

  it("does not present stored-only media as ready for Jarvis to inspect in the real message badge", () => {
    const markup = renderToStaticMarkup(
      <MessageFileBadges files={[{
        fileId: "private-video",
        name: "walkthrough.mp4",
        relativePath: "travel/walkthrough.mp4",
        mimeType: "video/mp4",
        sizeBytes: 2_048,
        status: "stored_only",
      }]} />,
    );

    expect(markup).toContain("walkthrough.mp4");
    expect(markup).toContain("saved only");
    expect(markup).toContain("Jarvis could not inspect this file&#x27;s contents.");
    expect(markup).toContain('href="/api/files/private-video"');
  });

  it("renders a ready private video through the native, owner-authenticated player", () => {
    const markup = renderToStaticMarkup(
      <Viewport
        panel={{ type: "private_video", value: "/api/files/private-video", title: "Travel walkthrough" }}
        onClose={() => undefined}
        onMinimize={() => undefined}
        full={false}
        onToggleFull={() => undefined}
      />,
    );

    expect(markup).toContain('<video');
    expect(markup).toContain('src="/api/files/private-video"');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('aria-label="Private video: Travel walkthrough"');
    expect(markup).not.toContain('<iframe');
  });
});
