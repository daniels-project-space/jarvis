import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: () => true }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: unknown) => Boolean(actor),
}));
vi.mock("@/lib/vault", () => ({ getSecret: mock.getSecret }));

import { verifyStreamingSttTicket } from "@/lib/streaming-stt-ticket.server";
import { POST } from "./route";

function request() {
  return new NextRequest("https://jarvis.example/api/voice/stream-ticket", { method: "POST" });
}

describe("streaming speech ticket API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.getSecret.mockImplementation(async (_service: string, key: string) => ({
      STREAMING_STT_PUBLIC_URL: "wss://speech.example/live",
      STREAMING_STT_TICKET_SECRET: "stream-ticket-secret",
    })[key] ?? "");
  });

  it("returns only a short-lived browser ticket, never the host secret", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ url: "wss://speech.example/live/v1/stream", sampleRate: 16_000 });
    expect(JSON.stringify(body)).not.toContain("stream-ticket-secret");
    expect(verifyStreamingSttTicket({ ticket: body.ticket, secret: "stream-ticket-secret" })).toMatchObject({
      origin: "https://jarvis.example",
    });
  });

  it("fails closed when no private CPU host has been configured", async () => {
    mock.getSecret.mockResolvedValue("");
    const response = await POST(request());
    expect(response.status).toBe(503);
  });

  it("does not mint a ticket without the owner session", async () => {
    mock.controlActor.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mock.getSecret).not.toHaveBeenCalled();
  });
});
