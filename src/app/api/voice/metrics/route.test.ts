import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "a".repeat(64) })),
}));

vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
  isSameOriginRequest: () => true,
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  isOwnerActor: (actor: unknown) => Boolean(actor),
}));

import { GET, POST } from "./route";

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

function summaryRequest() {
  return new NextRequest("https://jarvis.test/api/voice/metrics", { method: "GET" });
}

describe("voice metrics API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "a".repeat(64) });
    mock.controlMutation.mockResolvedValue("metric-id");
    mock.controlQuery.mockResolvedValue({
      sampleCount: 3,
      latencies: { captureToFirstAudio: { samples: 3, p50Ms: 1_500, p95Ms: 2_200 } },
    });
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

  it("returns only the owner aggregate through the private endpoint", async () => {
    const response = await GET(summaryRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      sampleCount: 3,
      latencies: { captureToFirstAudio: { samples: 3, p50Ms: 1_500, p95Ms: 2_200 } },
    });
    expect(mock.controlQuery).toHaveBeenCalledWith("voiceMetrics:summary", { authTokenHash: "a".repeat(64) });
  });

  it("does not expose the aggregate without an owner session", async () => {
    mock.controlActor.mockResolvedValue(null);
    const response = await GET(summaryRequest());
    expect(response.status).toBe(401);
    expect(mock.controlQuery).not.toHaveBeenCalled();
  });
});
