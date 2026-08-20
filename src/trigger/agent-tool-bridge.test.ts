import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentToolBridge,
  JARVIS_DYNAMIC_TOOLS,
  JARVIS_TOOL_INSTRUCTIONS,
} from "./agent-tool-bridge";
import { verifyForegroundOwnerToolReceipt } from "../lib/foreground-owner-tool-receipt.server";
import { TOOL_BELT_NAMES } from "../lib/tool-belts";
import type { CodexDynamicToolCall } from "./codex-app-server";

function dynamicCall(
  tool: string,
  args: unknown,
  invocationContext?: CodexDynamicToolCall["invocationContext"],
  signal?: AbortSignal,
  toolHostContext?: CodexDynamicToolCall["toolHostContext"],
): CodexDynamicToolCall {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    ...(invocationContext ? { invocationContext } : {}),
    ...(signal ? { signal } : {}),
    ...(toolHostContext ? { toolHostContext } : {}),
    namespace: null,
    tool,
    arguments: args,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/agent-tool`;
}

describe("foreground agent tool bridge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists and calls tools with Node fetch when curl and Python cannot resolve", async () => {
    vi.stubEnv("PATH", "/definitely/no/runner/binaries");
    expect((spawnSync("curl").error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    expect((spawnSync("python3").error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");

    const requests: Array<{ method: string; authorization: string; body: unknown; url: string }> = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString();
      requests.push({
        method: req.method ?? "",
        authorization: String(req.headers.authorization ?? ""),
        body: raw ? JSON.parse(raw) : null,
        url: req.url ?? "",
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        res.end(JSON.stringify([{ name: "show", description: "Show Daniel's requested view." }]));
      } else {
        res.end(JSON.stringify({ result: { echoed: JSON.parse(raw).args } }));
      }
    });
    const endpoint = await listen(server);
    const token = `dispatch-'"-$()-token`;
    const bridge = new AgentToolBridge(token, { endpoint, timeoutMs: 2_000 });

    try {
      const listed = await bridge.invoke(dynamicCall("jarvis_get_tools", { belt: "core" }));
      const args = { text: `Daniel's "quoted" $HOME; $(touch nope)\nnext line` };
      const invocationContext = { requestId: "request-1", userMessageId: "message-1" };
      const called = await bridge.invoke(dynamicCall(
        "jarvis_call_tool",
        { name: "show", args },
        invocationContext,
      ));

      expect(listed.success).toBe(true);
      expect(JSON.parse(listed.contentItems[0].type === "inputText" ? listed.contentItems[0].text : "null"))
        .toEqual([{ name: "show", description: "Show Daniel's requested view." }]);
      expect(called.success).toBe(true);
      expect(JSON.parse(called.contentItems[0].type === "inputText" ? called.contentItems[0].text : "null"))
        .toEqual({ result: { echoed: args } });
      expect(requests).toEqual([
        {
          method: "GET",
          authorization: `Bearer ${token}`,
          body: null,
          url: "/api/agent-tool?belt=core",
        },
        {
          method: "POST",
          authorization: `Bearer ${token}`,
          body: { name: "show", args, invocationContext },
          url: "/api/agent-tool",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not reflect an upstream error body that contains the bearer", async () => {
    const token = "dispatch-token-that-must-stay-private";
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end(`proxy accidentally echoed ${token}`);
    });
    const endpoint = await listen(server);
    const bridge = new AgentToolBridge(token, { endpoint, timeoutMs: 2_000 });

    try {
      const response = await bridge.invoke(dynamicCall("jarvis_get_tools", { belt: "core" }));
      const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "";
      expect(response.success).toBe(false);
      expect(text).toContain("HTTP 401");
      expect(text).not.toContain(token);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("marks an HTTP 200 tool failure as typed failure and emits safe telemetry", async () => {
    const events: Array<{ success: boolean; code: string; target: string; status?: number }> = [];
    const secret = "dispatch-token-that-must-stay-private";
    const bridge = new AgentToolBridge(secret, {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async () => Response.json({ result: `Tool failed: leaked ${secret}` }),
      onEvent: (event) => events.push(event),
    });

    const response = await bridge.invoke(dynamicCall("jarvis_call_tool", {
      name: "weather",
      args: { city: "Seville" },
    }));
    const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "";

    expect(response.success).toBe(false);
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "upstream_failure" },
    });
    expect(text).not.toContain(secret);
    expect(events).toEqual([expect.objectContaining({
      success: false,
      code: "upstream_failure",
      target: "weather",
      status: 200,
    })]);
  });

  it.each([
    "Maps key unavailable.",
    "Search unavailable right now.",
    "Weather lookup failed: upstream timed out.",
    "Travel map lookup failed: places API returned 503.",
  ])("treats a scoped provider failure as failure even behind HTTP 200: %s", async (result) => {
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async () => Response.json({ result }),
    });

    const response = await bridge.invoke(dynamicCall("jarvis_call_tool", {
      name: "travel_map",
      args: { location: "Sevilla" },
    }));

    expect(response.success).toBe(false);
    const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "";
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "upstream_failure" } });
  });

  it("routes natural visual intent locally and returns only relevant definitions", async () => {
    const requests: string[] = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async (input) => {
        requests.push(String(input));
        return Response.json([
          { name: "travel_map", description: "Render a real travel map." },
          { name: "places_near", description: "Find places." },
          { name: "transport_route", description: "Build a route." },
          { name: "trip_plan", description: "Plan a full trip." },
        ]);
      },
    });

    const response = await bridge.invoke(dynamicCall("jarvis_get_tools", {
      intent: "I'm in Sevilla right now, can you show me a map with some attractions in the city?",
    }));
    const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "null";
    const routed = JSON.parse(text);

    expect(response.success).toBe(true);
    expect(new URL(requests[0]).searchParams.get("belt")).toBe("travel");
    expect(routed).toMatchObject({ belt: "travel", mustRender: true });
    expect(routed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "travel_map",
      "places_near",
      "transport_route",
    ]);
  });

  it("routes a pasted YouTube URL to the transcript tool and creative belt", async () => {
    const requests: string[] = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async (input) => {
        requests.push(String(input));
        return Response.json([
          { name: "youtube_search", description: "Find YouTube videos." },
          { name: "youtube_transcript", description: "Open verified metadata and report authorised-caption availability." },
          { name: "draft", description: "Unrelated creative tool." },
        ]);
      },
    });

    const response = await bridge.invoke(dynamicCall("jarvis_get_tools", {
      intent: "Summarise https://www.youtube.com/watch?v=abcDEF12345",
    }));
    const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "null";
    const routed = JSON.parse(text);

    expect(response.success).toBe(true);
    expect(new URL(requests[0]).searchParams.get("belt")).toBe("creative");
    expect(routed).toMatchObject({ belt: "creative", mustRender: true });
    expect(routed.tools.map((tool: { name: string }) => tool.name)).toEqual(["youtube_transcript"]);
  });

  it("discovers both the day planner and its real rendering tool in one request", async () => {
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async () => Response.json([
        { name: "show", description: "Render the completed plan." },
        { name: "research", description: "Unrelated work tool." },
        { name: "plan_my_day", description: "Build the live plan facts." },
      ]),
    });

    const response = await bridge.invoke(dynamicCall("jarvis_get_tools", {
      intent: "Plan my day around my calendar",
    }));
    const text = response.contentItems[0].type === "inputText" ? response.contentItems[0].text : "null";
    const routed = JSON.parse(text);

    expect(response.success).toBe(true);
    expect(routed).toMatchObject({ belt: "work", mustRender: true });
    expect(routed.tools.map((tool: { name: string }) => tool.name)).toEqual(["plan_my_day", "show"]);
  });

  it("replays the same authoritative invocation context without placing it in tool arguments", async () => {
    const bodies: unknown[] = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ result: "accepted" });
      },
    });
    const invocationContext = { requestId: "stable-request", userMessageId: "stable-message" };
    const call = dynamicCall("jarvis_call_tool", {
      name: "show",
      args: { kind: "markdown", value: "hello" },
    }, invocationContext);

    await bridge.invoke(call);
    await bridge.invoke(call);

    expect(bodies).toEqual([
      {
        name: "show",
        args: { kind: "markdown", value: "hello" },
        invocationContext,
      },
      {
        name: "show",
        args: { kind: "markdown", value: "hello" },
        invocationContext,
      },
    ]);
  });

  it("propagates turn cancellation into HTTP fetch and rejects a late response", async () => {
    let resolveFetch!: (response: Response) => void;
    let forwardedSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      fetchImplementation,
      timeoutMs: 10_000,
    });
    const abort = new AbortController();
    const pending = bridge.invoke(dynamicCall(
      "jarvis_get_tools",
      { belt: "core" },
      undefined,
      abort.signal,
    ));
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));

    abort.abort();
    const response = await pending;
    expect(forwardedSignal?.aborted).toBe(true);
    expect(response.success).toBe(false);
    expect(response.contentItems[0]).toMatchObject({
      type: "inputText",
      text: expect.stringContaining("cancelled"),
    });

    resolveFetch(Response.json({ result: "late" }));
    await Promise.resolve();
    expect(response.success).toBe(false);
  });

  it("passes the turn signal to attached-file search and fences its late result", async () => {
    let resolveSearch!: (value: unknown) => void;
    let forwardedSignal: AbortSignal | undefined;
    const searchAttachedFiles = vi.fn((_messageId: string, request: { signal?: AbortSignal }) => {
      forwardedSignal = request.signal;
      return new Promise<unknown>((resolve) => { resolveSearch = resolve; });
    });
    const bridge = new AgentToolBridge("dispatch-token", { searchAttachedFiles });
    const abort = new AbortController();
    const pending = bridge.invoke(dynamicCall(
      "jarvis_search_attached_files",
      { mode: "search", query: "invoice" },
      { requestId: "request-search", userMessageId: "message-search" },
      abort.signal,
    ));
    await vi.waitFor(() => expect(searchAttachedFiles).toHaveBeenCalledTimes(1));

    abort.abort();
    const response = await pending;
    expect(forwardedSignal).toBe(abort.signal);
    expect(forwardedSignal?.aborted).toBe(true);
    expect(response.success).toBe(false);
    resolveSearch([{ fileId: "late-file" }]);
    await Promise.resolve();
    expect(response.success).toBe(false);
  });

  it("scopes local file search to the trusted invoking message", async () => {
    const searchAttachedFiles = vi.fn(async () => ({
      mode: "read",
      results: [{ fileId: "attached-1", ordinal: 3, text: "bounded evidence" }],
      nextOrdinal: 3,
      hasMore: false,
    }));
    const bridge = new AgentToolBridge("dispatch-token", { searchAttachedFiles });
    const response = await bridge.invoke(dynamicCall(
      "jarvis_search_attached_files",
      { mode: "read", fileId: "attached-1", afterOrdinal: 1 },
      { requestId: "request-1", userMessageId: "trusted-message-1" },
    ));
    expect(response.success).toBe(true);
    expect(searchAttachedFiles).toHaveBeenCalledWith("trusted-message-1", {
      mode: "read",
      fileId: "attached-1",
      afterOrdinal: 1,
    });
    expect(response.contentItems[0]).toMatchObject({ type: "inputText" });
  });

  it("fails closed before the external bridge when original-message authorization is absent", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ result: "must not run" }));
    const authorizeTool = vi.fn(async () => ({ allowed: false, reason: "file_turn_action_not_requested" }));
    const bridge = new AgentToolBridge("dispatch-token", {
      fetchImplementation,
      authorizeTool,
      endpoint: "https://jarvis.test/api/agent-tool",
    });
    const denied = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "web_search", args: { query: "private excerpt" } },
      { requestId: "request-2", userMessageId: "trusted-message-2" },
    ));
    expect(denied.success).toBe(false);
    expect(authorizeTool).toHaveBeenCalledWith("trusted-message-2", "web_search");
    expect(fetchImplementation).not.toHaveBeenCalled();

    const missingProvenance = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "web_search", args: { query: "private excerpt" } },
    ));
    expect(missingProvenance.success).toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("uses the separate signed owner endpoint for explicit Gmail turns only", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      ownerEndpoint: "https://jarvis.test/api/foreground-owner-tool",
      ownerToolReceiptSecret: "w".repeat(48),
      fetchImplementation: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, init });
        if (url.pathname.endsWith("/foreground-owner-tool")) {
          if (init?.method === "GET") return Response.json([
            { name: "gmail_search", description: "Search Gmail." },
            { name: "gmail_read", description: "Read Gmail." },
            { name: "gmail_list_subscriptions", description: "List subscriptions." },
          ]);
          return Response.json({ result: "found matching mail" });
        }
        return Response.json([]);
      },
    });
    const hostContext = {
      foregroundOwnerToolTurn: {
        messageId: "message-1",
        assistantId: "assistant-1",
        claimToken: "claim-1",
      },
    } as const;

    const listed = await bridge.invoke(dynamicCall(
      "jarvis_get_tools",
      { intent: "Search my Gmail inbox for hotel confirmation emails" },
      undefined,
      undefined,
      hostContext,
    ));
    const called = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "gmail_search", args: { query: "hotel" } },
      { userMessageId: "message-1" },
      undefined,
      hostContext,
    ));

    expect(listed.success).toBe(true);
    expect(called.success).toBe(true);
    const ownerRequests = requests.filter(({ url }) => url.pathname.endsWith("/foreground-owner-tool"));
    expect(ownerRequests).toHaveLength(2);
    expect(ownerRequests[0].url.searchParams.get("belt")).toBe("work");
    expect(ownerRequests[0].init?.headers).toMatchObject({
      authorization: "Bearer dispatch-token",
      "x-jarvis-owner-tool-receipt": expect.any(String),
    });
    expect(JSON.parse(String(ownerRequests[1].init?.body))).toEqual({
      name: "gmail_search",
      args: { query: "hotel" },
    });
    expect(String(ownerRequests[1].init?.body)).not.toContain("claim-1");
  });

  it("keeps an explicit owner email-support draft on the signed foreground lane", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      ownerEndpoint: "https://jarvis.test/api/foreground-owner-tool",
      ownerToolReceiptSecret: "w".repeat(48),
      fetchImplementation: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, init });
        if (url.pathname.endsWith("/foreground-owner-tool")) {
          return init?.method === "GET"
            ? Response.json([{ name: "email_support", description: "Draft an owner-approved support email." }])
            : Response.json({ result: "Drafted the support email." });
        }
        return Response.json([]);
      },
    });
    const hostContext = {
      foregroundOwnerToolTurn: {
        messageId: "message-1",
        assistantId: "assistant-1",
        claimToken: "claim-1",
      },
    } as const;

    const listed = await bridge.invoke(dynamicCall(
      "jarvis_get_tools",
      { intent: "Email Rakuten and ask about cashback claims in the EU" },
      undefined,
      undefined,
      hostContext,
    ));
    const called = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "email_support", args: { company: "Rakuten", ask: "Please explain EU cashback claims." } },
      { userMessageId: "message-1" },
      undefined,
      hostContext,
    ));

    expect(listed.success).toBe(true);
    expect(called.success).toBe(true);
    const ownerRequests = requests.filter(({ url }) => url.pathname.endsWith("/foreground-owner-tool"));
    expect(ownerRequests).toHaveLength(2);
    expect(ownerRequests[0].url.searchParams.get("belt")).toBe("core");
    expect(ownerRequests[0].init?.headers).toMatchObject({
      authorization: "Bearer dispatch-token",
      "x-jarvis-owner-tool-receipt": expect.any(String),
    });
    expect(JSON.parse(String(ownerRequests[1].init?.body))).toEqual({
      name: "email_support",
      args: { company: "Rakuten", ask: "Please explain EU cashback claims." },
    });
    expect(requests.filter(({ url, init }) => url.pathname.endsWith("/agent-tool") && init?.method === "POST")).toEqual([]);
  });

  it("binds a foreground browser run receipt to its exact errand and rejects injected steps before any request", async () => {
    const secret = "w".repeat(48);
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const bridge = new AgentToolBridge("dispatch-token", {
      endpoint: "https://jarvis.test/api/agent-tool",
      ownerEndpoint: "https://jarvis.test/api/foreground-owner-tool",
      ownerToolReceiptSecret: secret,
      fetchImplementation: async (input, init) => {
        requests.push({ url: new URL(String(input)), init });
        return Response.json({ result: "browser task started" });
      },
    });
    const hostContext = {
      foregroundOwnerToolTurn: {
        messageId: "message-1",
        assistantId: "assistant-1",
        claimToken: "claim-1",
      },
    } as const;

    const called = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "browser_errand_run", args: { errand_id: "browserErrand123" } },
      { userMessageId: "message-1" },
      undefined,
      hostContext,
    ));
    expect(called.success).toBe(true);
    expect(requests).toHaveLength(1);
    const receipt = verifyForegroundOwnerToolReceipt(
      (requests[0].init?.headers as Record<string, string>)["x-jarvis-owner-tool-receipt"],
      secret,
    );
    expect(receipt).toMatchObject({
      operation: "invoke",
      target: "browser_errand_run:browserErrand123",
    });

    const injected = await bridge.invoke(dynamicCall(
      "jarvis_call_tool",
      { name: "browser_errand_run", args: { errand_id: "browserErrand123", steps: [{ action: "type" }] } },
      { userMessageId: "message-1" },
      undefined,
      hostContext,
    ));
    expect(injected.success).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("advertises native JSON tools without shell or capability-token instructions", () => {
    expect(JARVIS_DYNAMIC_TOOLS.map((tool) => tool.name)).toEqual([
      "jarvis_search_attached_files",
      "jarvis_get_tools",
      "jarvis_call_tool",
    ]);
    const getTools = JARVIS_DYNAMIC_TOOLS.find((tool) => tool.name === "jarvis_get_tools");
    const properties = getTools?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.belt.enum).toEqual(TOOL_BELT_NAMES);
    expect(JARVIS_TOOL_INSTRUCTIONS).not.toMatch(/curl|python3|JARVIS_DISPATCH_TOKEN/i);
  });
});
