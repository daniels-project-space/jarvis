import { afterEach, describe, expect, it, vi } from "vitest";
import { primeMicrophone, readJarvisPermissions, watchMicrophonePermission } from "./permissions";

const originalNavigator = globalThis.navigator;
const originalLocalStorage = globalThis.localStorage;
const originalNotification = globalThis.Notification;

function installBrowser(args: {
  stored?: string | null;
  permissionQuery?: (() => Promise<PermissionStatus>) | null;
  getUserMedia?: () => Promise<MediaStream>;
}) {
  const storage = new Map<string, string>();
  if (args.stored != null) storage.set("jarvis_microphone_granted", args.stored);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: { getUserMedia: args.getUserMedia ?? vi.fn() },
      permissions: args.permissionQuery === null ? undefined : { query: args.permissionQuery },
    },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "default" },
  });
  return storage;
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: originalNotification });
  vi.restoreAllMocks();
});

describe("microphone permission lifecycle", () => {
  it("uses a successful stored grant on Safari-style browsers without Permissions API", async () => {
    installBrowser({ stored: "1", permissionQuery: null });
    await expect(readJarvisPermissions()).resolves.toMatchObject({ microphone: "granted" });
  });

  it("uses the stored grant when permission query is unsupported", async () => {
    installBrowser({ stored: "1", permissionQuery: async () => { throw new Error("unsupported"); } });
    await expect(readJarvisPermissions()).resolves.toMatchObject({ microphone: "granted" });
  });

  it("records a successful grant and clears it when the browser denies capture", async () => {
    const stop = vi.fn();
    const storage = installBrowser({
      permissionQuery: null,
      getUserMedia: vi.fn().mockResolvedValueOnce({ getTracks: () => [{ stop }] } as unknown as MediaStream)
        .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError")),
    });
    await expect(primeMicrophone()).resolves.toBe("granted");
    expect(storage.get("jarvis_microphone_granted")).toBe("1");
    expect(stop).toHaveBeenCalledOnce();
    await expect(primeMicrophone()).resolves.toBe("denied");
    expect(storage.has("jarvis_microphone_granted")).toBe(false);
  });

  it("observes browser permission revocation and removes the stale hint", async () => {
    let change: (() => void) | undefined;
    const status = {
      state: "granted",
      addEventListener: (_name: string, listener: () => void) => { change = listener; },
      removeEventListener: vi.fn(),
    } as unknown as PermissionStatus;
    const storage = installBrowser({ stored: "1", permissionQuery: async () => status });
    const seen: string[] = [];
    const stop = await watchMicrophonePermission((permission) => seen.push(permission));
    Object.assign(status, { state: "denied" });
    change?.();
    expect(seen).toEqual(["denied"]);
    expect(storage.has("jarvis_microphone_granted")).toBe(false);
    stop();
    expect(status.removeEventListener).toHaveBeenCalledOnce();
  });
});
