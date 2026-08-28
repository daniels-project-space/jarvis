import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlMutation: vi.fn(),
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "a".repeat(64) })),
}));

vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  isOwnerActor: (actor: unknown) => Boolean(actor),
}));

import { POST } from "./route";

const metric = {
  turnId: "voice-123",
  transcriptSource: "server",
  endpointStrategy: "standard",
  researchState: "promoted",
  researchSourceCount: 3,
  outcome: "audible",
  captureToSpeechClosedMs: 900,
  speechClosedToTranscriptMs: 300,
  transcriptToQueuedMs: 200,
  queuedToFirstAudioMs: 500,
  captureToFirstAudioMs: 1_900,
};

function request(body: unknown) {
  return new NextRequest("https://jarvis.test/api/voice/metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("voice metrics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "a".repeat(64) });
    mock.controlMutation.mockResolvedValue("metric-id");
  });

  it("accepts only anonymous performance counters and binds them to owner control", async () => {
    const response = await POST(request(metric));
    expect(response.status).toBe(200);
    expect(mock.controlMutation).toHaveBeenCalledWith("voiceMetrics:record", {
      ...metric,
      authTokenHash: "a".repeat(64),
    });
  });

  it("rejects unexpected text fields before they can become telemetry", async () => {
    const response = await POST(request({ ...metric, transcript: "private speech" }));
    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("accepts only the two endpoint categories used for latency comparison", async () => {
    const response = await POST(request({ ...metric, endpointStrategy: "fingerprint-me" }));
    expect(response.status).toBe(400);
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });
});
