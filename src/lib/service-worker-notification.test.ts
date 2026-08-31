import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = { waitUntil(promise: Promise<unknown>): void };

function loadServiceWorker(existingNotifications: Array<{ title: string; body: string; close: () => void }> = []) {
  const listeners = new Map<string, (event: WorkerEvent & Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const context = {
    self: {
      addEventListener: (type: string, listener: (event: WorkerEvent & Record<string, unknown>) => void) => {
        listeners.set(type, listener);
      },
      skipWaiting,
      clients: { claim, matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) },
      registration: {
        getNotifications: vi.fn(async () => existingNotifications),
        showNotification,
      },
    },
    clients: { matchAll: vi.fn(async () => []) },
    Promise,
  };
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), context);
  return { listeners, showNotification, claim, skipWaiting };
}

async function dispatch(
  listener: ((event: WorkerEvent & Record<string, unknown>) => void) | undefined,
  event: Record<string, unknown> = {},
) {
  let completion: Promise<unknown> | undefined;
  listener?.({ ...event, waitUntil: (promise) => { completion = promise; } });
  await completion;
}

describe("Jarvis service-worker notification retirement", () => {
  it("activates the push-only repair without waiting for every old tab to close", async () => {
    const worker = loadServiceWorker();

    await dispatch(worker.listeners.get("install"));

    expect(worker.skipWaiting).toHaveBeenCalledOnce();
  });

  it("closes retired connection and routine-health notifications when the repaired worker activates", async () => {
    const retired = { title: "JARVIS needs you", body: "Approve root-cause repair for repeated failed fetch", close: vi.fn() };
    const health = { title: "JARVIS health check", body: "All systems operational", close: vi.fn() };
    const current = { title: "Reminder", body: "Call Maya", close: vi.fn() };
    const worker = loadServiceWorker([retired, health, current]);

    await dispatch(worker.listeners.get("activate"));

    expect(worker.claim).toHaveBeenCalledOnce();
    expect(retired.close).toHaveBeenCalledOnce();
    expect(health.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
  });

  it.each([
    { title: "JARVIS needs you", body: "Failed to fetch" },
    { title: "JARVIS health check", body: "All systems operational" },
    { title: "Jarvis is connected", body: "Connection restored" },
  ])("silently discards a delayed generic payload: $title", async (payload) => {
    const worker = loadServiceWorker();

    await dispatch(worker.listeners.get("push"), {
      data: {
        json: () => ({ ...payload, url: "/" }),
        text: () => "",
      },
    });

    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("still delivers an explicit reminder", async () => {
    const worker = loadServiceWorker();

    await dispatch(worker.listeners.get("push"), {
      data: {
        json: () => ({ title: "Reminder", body: "Call Maya", url: "/" }),
        text: () => "",
      },
    });

    expect(worker.showNotification).toHaveBeenCalledWith(
      "Reminder",
      expect.objectContaining({ body: "Call Maya" }),
    );
  });
});
