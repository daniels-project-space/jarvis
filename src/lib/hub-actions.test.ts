import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  HubActionsTimeoutError,
  HubActionsUnavailableError,
  createHubTodo,
  getHubWealth,
  hubActionsReadiness,
  hubActionsRequestArgs,
  listHubTodos,
  listHubWidgets,
  updateHubTodo,
} from "./hub-actions";

const ENV = {
  JARVIS_HUB_ACTIONS_TOKEN: " dedicated-jarvis-actions-token ",
  VAULT_ACCESS_TOKEN: "broad-vault-token-must-not-be-used",
};

function response(value: unknown): Response {
  return Response.json({ value });
}

describe("Project Hub Jarvis actions capability", () => {
  it("uses only its dedicated capability and never falls back to the broad vault credential", () => {
    expect(hubActionsRequestArgs(ENV)).toEqual({ vaultToken: "dedicated-jarvis-actions-token" });
    expect(hubActionsReadiness(ENV)).toEqual({ configured: true });
    expect(hubActionsRequestArgs({ VAULT_ACCESS_TOKEN: ENV.VAULT_ACCESS_TOKEN })).toBeNull();
    expect(hubActionsReadiness({ JARVIS_HUB_ACTIONS_TOKEN: "   " })).toEqual({ configured: false });
  });

  it("fails closed before any request when the dedicated capability is absent", async () => {
    const fetchImpl = vi.fn();
    await expect(listHubTodos({ environment: { VAULT_ACCESS_TOKEN: ENV.VAULT_ACCESS_TOKEN }, fetchImpl })).rejects.toBeInstanceOf(HubActionsUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the capability only in bounded server-to-server action bodies", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response([]));
    await listHubTodos({ environment: ENV, fetchImpl, hubUrl: "https://hub.example" });
    await listHubWidgets({ environment: ENV, fetchImpl, hubUrl: "https://hub.example" });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://hub.example/api/query", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
    }));
    expect(fetchImpl.mock.calls[0]?.[0]).not.toContain("dedicated-jarvis-actions-token");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      path: "jarvisActions:listTodos",
      args: { vaultToken: "dedicated-jarvis-actions-token" },
      format: "json",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      path: "jarvisActions:listWidgets",
      args: { vaultToken: "dedicated-jarvis-actions-token" },
      format: "json",
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads only the bounded aggregate wealth façade and rejects malformed totals", async () => {
    const value = {
      totalGBP: 123_456,
      asOf: 1_800_000_000_000,
      oldestPricedAt: 1_799_000_000_000,
      assetCount: 7,
      usdPerGbp: 1.3,
      categories: [{ category: "cash", totalGBP: 12_000 }],
      cashflow: { confirmedRentalGbp: 900, expensesAccruedGbp: 300, netCashflowGbp: 600 },
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(value));

    await expect(getHubWealth({ environment: ENV, fetchImpl, hubUrl: "https://hub.example" }))
      .resolves.toEqual(value);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      path: "jarvisActions:getWealth",
      args: { vaultToken: "dedicated-jarvis-actions-token" },
      format: "json",
    });

    const malformed = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ...value, totalGBP: "not-a-number" }));
    await expect(getHubWealth({ environment: ENV, fetchImpl: malformed }))
      .rejects.toThrow("invalid total");
  });

  it("fails closed on a bounded overall deadline even when an injected transport ignores abort", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    await expect(listHubTodos({ environment: ENV, fetchImpl: fetchImpl as typeof fetch, timeoutMs: 25 }))
      .rejects.toBeInstanceOf(HubActionsTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("includes a stalled response body in the same Hub deadline", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        json: () => new Promise<unknown>(() => {}),
      } as Response);
    });

    await expect(listHubTodos({ environment: ENV, fetchImpl: fetchImpl as typeof fetch, timeoutMs: 25 }))
      .rejects.toBeInstanceOf(HubActionsTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("fails closed on a malformed read body without exposing parser details", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("unexpected Hub body")),
    } as Response));

    await expect(listHubTodos({ environment: ENV, fetchImpl }))
      .rejects.toThrow("Project Hub jarvisActions:listTodos failed");
  });

  it.each([
    ["array", []],
    ["empty object", {}],
    ["string", "not a Hub action payload"],
  ])("fails closed when a read body is a %s without a value field", async (_description, body) => {
    const fetchImpl = vi.fn(async () => Response.json(body));

    await expect(listHubTodos({ environment: ENV, fetchImpl }))
      .rejects.toThrow("Project Hub jarvisActions:listTodos failed");
  });

  it("fails closed when either list query returns a non-list value", async () => {
    const readActions = [
      ["jarvisActions:listTodos", listHubTodos],
      ["jarvisActions:listWidgets", listHubWidgets],
    ] as const;

    for (const [path, read] of readActions) {
      for (const value of [{}, "not a Hub list"]) {
        const fetchImpl = vi.fn(async () => Response.json({ value }));
        await expect(read({ environment: ENV, fetchImpl }))
          .rejects.toThrow(`Project Hub ${path} failed`);
      }
    }
  });

  it("keeps mutation transport unchanged even when a query deadline is requested", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // A mutation that takes longer than a query's requested test deadline
      // must still resolve rather than returning a false failed-write result.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(init).not.toHaveProperty("signal");
      return response({ id: "todo-1" });
    });

    await expect(createHubTodo(
      { text: "Keep the write outcome truthful" },
      { environment: ENV, fetchImpl, timeoutMs: 25 },
    )).resolves.toEqual({ id: "todo-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses only the façade's bounded create and update fields", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ id: "todo-1" }));
    await createHubTodo({ text: "Prepare Seville map", priority: 2, dueDate: 123, tags: ["jarvis"] }, { environment: ENV, fetchImpl });
    await updateHubTodo({ id: "todo-1", text: "Prepare Madrid map", done: true }, { environment: ENV, fetchImpl });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      path: "jarvisActions:createTodo",
      args: { text: "Prepare Seville map", priority: 2, dueDate: 123, tags: ["jarvis"], vaultToken: "dedicated-jarvis-actions-token" },
      format: "json",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      path: "jarvisActions:updateTodo",
      args: { id: "todo-1", text: "Prepare Madrid map", done: true, vaultToken: "dedicated-jarvis-actions-token" },
      format: "json",
    });
  });
});
