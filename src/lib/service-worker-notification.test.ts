import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = { waitUntil(promise: Promise<unknown>): void };

function loadServiceWorker(existingNotifications: Array<{ title: string; body: string; close: () => void }> = []) {
  const listeners = new Map<string, (event: WorkerEvent & Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const context = {
    self: {
      addEventListener: (type: string, listener: (event: WorkerEvent & Record<string, unknown>) => void) => {
        listeners.set(type, listener);
      },
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
  return { listeners, showNotification, claim };
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
  it("closes retired failed-fetch notifications when the repaired worker activates", async () => {
    const retired = { title: "JARVIS needs you", body: "Approve root-cause repair for repeated failed fetch", close: vi.fn() };
    const current = { title: "Reminder", body: "Call Maya", close: vi.fn() };
    const worker = loadServiceWorker([retired, current]);

    await dispatch(worker.listeners.get("activate"));

    expect(worker.claim).toHaveBeenCalledOnce();
    expect(retired.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
  });

  it("never resurfaces a delayed raw failed-fetch push payload", async () => {
    const worker = loadServiceWorker();

    await dispatch(worker.listeners.get("push"), {
      data: {
        json: () => ({ title: "JARVIS needs you", body: "Failed to fetch", url: "/" }),
        text: () => "",
      },
    });

    expect(worker.showNotification).toHaveBeenCalledWith(
      "Jarvis is connected",
      expect.objectContaining({
        body: "The earlier connection alert is resolved. Nothing is waiting on you.",
        tag: "jarvis-connection-recovered",
      }),
    );
    expect(JSON.stringify(worker.showNotification.mock.calls)).not.toMatch(/failed to fetch/i);
  });
});
