import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  accessToken: vi.fn(async () => "test-access-token"),
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

vi.mock("server-only", () => ({}));
vi.mock("./google-oauth", () => ({ getGoogleAccessTokenForGmail: mock.accessToken }));
vi.mock("node:dns/promises", () => ({ lookup: mock.lookup }));

import { gmailCreateDraft, gmailUnsubscribe } from "./gmail";
import { GOOGLE_GMAIL_COMPOSE_SCOPE, GOOGLE_GMAIL_READONLY_SCOPE } from "./google-scopes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mock.accessToken.mockClear();
  mock.lookup.mockClear();
});

function unsubscribeMetadata(endpoint: string) {
  return new Response(JSON.stringify({
    id: "message-1",
    payload: {
      headers: [
        { name: "List-Unsubscribe", value: `<${endpoint}>` },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Gmail one-click unsubscribe boundary", () => {
  it("posts only to a resolved public HTTPS endpoint and never follows redirects", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("gmail.googleapis.com")) return unsubscribeMetadata("https://unsubscribe.example/one-click");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(gmailUnsubscribe("message-1")).resolves.toEqual({ method: "one-click-post" });
    expect(mock.accessToken).toHaveBeenCalledWith([GOOGLE_GMAIL_READONLY_SCOPE]);
    expect(mock.lookup).toHaveBeenCalledWith("unsubscribe.example", { all: true, verbatim: true });
    const [, request] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(request).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("rejects private or malformed unsubscribe targets before any external fetch", async () => {
    const fetchMock = vi.fn(async () => unsubscribeMetadata("https://127.0.0.1/admin"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await gmailUnsubscribe("message-1");
    expect(result).toEqual({
      method: "unavailable",
      reason: "The sender's one-click endpoint was not a safe public HTTPS destination.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mock.lookup).not.toHaveBeenCalled();
  });

  it("does not expose or follow a one-click redirect", async () => {
    const endpoint = "https://unsubscribe.example/one-click?secret=do-not-log";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("gmail.googleapis.com")) return unsubscribeMetadata(endpoint);
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await gmailUnsubscribe("message-1");
    expect(result).toEqual({
      method: "unavailable",
      reason: "The sender's one-click unsubscribe endpoint returned HTTP 302.",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-log");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
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
    expect(mock.accessToken).toHaveBeenCalledWith([GOOGLE_GMAIL_COMPOSE_SCOPE]);
  });

  it("does not reflect a Gmail provider error body into the chat-visible failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "private mailbox detail" } }), { status: 403 })));

    const error = await gmailCreateDraft({
      to: "daniel@example.com",
      subject: "A safe subject",
      body: "Hello from Jarvis.",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("Gmail request failed (HTTP 403)");
    expect(String((error as Error).message)).not.toContain("private mailbox detail");
  });
});
