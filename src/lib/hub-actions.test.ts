import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  HubActionsUnavailableError,
  createHubTodo,
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
