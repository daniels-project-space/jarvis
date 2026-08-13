import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  accessToken: vi.fn(async () => "test-access-token"),
}));

vi.mock("server-only", () => ({}));
vi.mock("./google-oauth", () => ({ getGoogleAccessToken: mock.accessToken }));

import { gmailCreateDraft } from "./gmail";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mock.accessToken.mockClear();
});

describe("Gmail draft MIME boundary", () => {
  it("rejects recipient and subject header injection before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(gmailCreateDraft({
      to: "victim@example.com\r\nBcc: attacker@example.com",
      subject: "Hello",
      body: "Hi",
    })).rejects.toThrow(/Recipient cannot contain line breaks/i);
    await expect(gmailCreateDraft({
      to: "victim@example.com",
      subject: "Hello\r\nBcc: attacker@example.com",
      body: "Hi",
    })).rejects.toThrow(/Subject cannot contain line breaks/i);

    expect(mock.accessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes safe recipients into one bounded To header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "draft-1",
      message: { id: "message-1", threadId: "thread-1" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(gmailCreateDraft({
      to: "Daniel Example <daniel@example.com>, alex@example.org",
      subject: "A safe subject",
      body: "Hello from Jarvis.",
    })).resolves.toEqual({ draftId: "draft-1", messageId: "message-1", threadId: "thread-1" });

    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as { message: { raw: string } };
    const raw = Buffer.from(payload.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("To: Daniel Example <daniel@example.com>, alex@example.org\r\n");
    expect(raw).toContain("Subject: A safe subject\r\n");
    expect(raw).not.toContain("\r\nBcc:");
  });
});
