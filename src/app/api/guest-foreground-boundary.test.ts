import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(),
  convexMutation: vi.fn(),
  convexQuery: vi.fn(),
  trigger: vi.fn(),
  getSecret: vi.fn(),
  executeTool: vi.fn(),
  r2Put: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  actorAdminHash: vi.fn(),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/context", () => ({
  convexMutation: mock.convexMutation,
  convexQuery: mock.convexQuery,
  reportIncident: vi.fn(),
}));
vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/vault", () => ({ getSecret: mock.getSecret }));
vi.mock("@/lib/sttvocab", () => ({ STT_PROMPT: "" }));
vi.mock("@/lib/transcript", () => ({
  cleanSpeechTranscript: (text: string) => text,
  hasConfidentSpeechSegments: () => true,
  isMeaningfulSpeechTranscript: (text: string) => Boolean(text),
  shouldIgnoreHandsFreeTranscript: () => false,
}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/tools", () => ({ TOOL_DEFS: [{ name: "dispatch_agent" }], executeTool: mock.executeTool }));
vi.mock("@/lib/tool-belts", () => ({ TOOL_BELTS: { core: new Set(["dispatch_agent"]) }, slimToolDefinition: (value: unknown) => value }));
vi.mock("@/lib/r2", () => ({ r2Put: mock.r2Put }));

import { POST as chatPost } from "./chat/route";
import { POST as sttPost } from "./stt/route";
import { GET as ttsGet } from "./tts/route";
import { GET as toolsGet, POST as toolsPost } from "./tools/route";
import { POST as seePost } from "./see/route";

const guest = { kind: "guest" as const, guestId: "g".repeat(32) };

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://jarvis.test${path}`, init) as any;
}

describe("guest foreground boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue(guest);
    mock.convexMutation.mockResolvedValue("message-1");
    mock.trigger.mockResolvedValue({ id: "trigger-1" });
  });

  it("accepts a guest text turn into only its private conversation partition", async () => {
    const response = await chatPost(request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", threadId: "main", requestId: "guest-turn" }),
    }));

    expect(response.status).toBe(200);
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:sendMessage", expect.objectContaining({
      guestId: guest.guestId, threadId: "main", text: "Hello",
    }));
    expect(mock.convexQuery).not.toHaveBeenCalled();
  });

  it("accepts a guest STT and TTS foreground transport", async () => {
    const stt = await sttPost(request("/api/stt", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(256),
    }));
    const tts = await ttsGet(request("/api/tts"));

    expect(stt.status).toBe(200);
    await expect(stt.json()).resolves.toEqual({ text: "" });
    expect(tts.status).toBe(204);
  });

  it("denies guests the capability catalogue, tool execution, and visual upload", async () => {
    const [catalogue, tool, visual] = await Promise.all([
      toolsGet(request("/api/tools?live=1")),
      toolsPost(request("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "dispatch_agent", args: {} }),
      })),
      seePost(request("/api/see", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: "data:image/jpeg;base64,AA==" }),
      })),
    ]);

    expect(catalogue.status).toBe(403);
    expect(tool.status).toBe(403);
    expect(visual.status).toBe(403);
    expect(mock.executeTool).not.toHaveBeenCalled();
    expect(mock.r2Put).not.toHaveBeenCalled();
  });
});
