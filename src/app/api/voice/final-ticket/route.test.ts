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

import { verifyLocalSttTicket } from "@/lib/local-stt-ticket.server";
import { POST } from "./route";

const request = () => new NextRequest("https://jarvis.example/api/voice/final-ticket", { method: "POST" });

describe("direct final speech ticket API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.getSecret.mockImplementation(async (_service: string, key: string) => ({
      LOCAL_STT_URL: "https://speech.example",
      LOCAL_STT_SHARED_SECRET: "local-speech-host-secret",
    })[key] ?? "");
  });

  it("returns a one-use upload ticket and never the long-lived secret", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ url: "https://speech.example/v1/audio/transcriptions" });
    expect(body.prompt).toMatch(/jarvis/i);
    expect(JSON.stringify(body)).not.toContain("local-speech-host-secret");
    expect(verifyLocalSttTicket({ ticket: body.ticket, secret: "local-speech-host-secret" })).toMatchObject({
      origin: "https://jarvis.example",
    });
  });

  it("fails closed without the private host or the owner session", async () => {
    mock.getSecret.mockResolvedValue("");
    expect((await POST(request())).status).toBe(503);
    mock.controlActor.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
  });
});
