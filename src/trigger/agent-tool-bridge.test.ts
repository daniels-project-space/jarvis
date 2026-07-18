import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentToolBridge,
  JARVIS_DYNAMIC_TOOLS,
  JARVIS_TOOL_INSTRUCTIONS,
} from "./agent-tool-bridge";
import type { CodexDynamicToolCall } from "./codex-app-server";

function dynamicCall(tool: string, args: unknown): CodexDynamicToolCall {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
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
    const token = `dispatch-'\"-$()-token`;
    const bridge = new AgentToolBridge(token, { endpoint, timeoutMs: 2_000 });

    try {
      const listed = await bridge.invoke(dynamicCall("jarvis_get_tools", { belt: "core" }));
      const args = { text: `Daniel's \"quoted\" $HOME; $(touch nope)\nnext line` };
      const called = await bridge.invoke(dynamicCall("jarvis_call_tool", { name: "show", args }));

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
          body: { name: "show", args },
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

  it("advertises native JSON tools without shell or capability-token instructions", () => {
    expect(JARVIS_DYNAMIC_TOOLS.map((tool) => tool.name)).toEqual([
      "jarvis_get_tools",
      "jarvis_call_tool",
    ]);
    expect(JARVIS_TOOL_INSTRUCTIONS).not.toMatch(/curl|python3|JARVIS_DISPATCH_TOKEN/i);
  });
});
