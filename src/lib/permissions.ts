"use client";

export type BrowserPermission = "granted" | "prompt" | "denied" | "unsupported";

export type JarvisPermissionState = {
  microphone: BrowserPermission;
  notifications: BrowserPermission;
};

function notificationState(): BrowserPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission === "default" ? "prompt" : Notification.permission;
}

const MICROPHONE_GRANT_KEY = "jarvis_microphone_granted";

function storedMicrophoneGrant(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MICROPHONE_GRANT_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberMicrophoneGrant(): void {
  try { localStorage.setItem(MICROPHONE_GRANT_KEY, "1"); } catch { /* storage may be disabled */ }
}

export function forgetMicrophoneGrant(): void {
  try { localStorage.removeItem(MICROPHONE_GRANT_KEY); } catch { /* storage may be disabled */ }
}

export async function readJarvisPermissions(): Promise<JarvisPermissionState> {
  let microphone: BrowserPermission =
    typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia ? "unsupported" : "prompt";
  if (microphone !== "unsupported" && navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      microphone = status.state;
    } catch {
      // Safari does not expose microphone through Permissions even though
      // getUserMedia works. Use only our last successful grant as a boot hint;
      // startLive still performs the real browser permission check.
      if (storedMicrophoneGrant()) microphone = "granted";
    }
  } else if (microphone !== "unsupported" && storedMicrophoneGrant()) {
    // Safari variants may support getUserMedia without exposing microphone in
    // the Permissions API. A prior successful stream is a boot hint only; the
    // next getUserMedia call remains the browser's source of truth.
    microphone = "granted";
  }
  return { microphone, notifications: notificationState() };
}

export async function watchMicrophonePermission(
  onChange: (permission: BrowserPermission) => void,
): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return () => undefined;
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    const changed = () => {
      const permission = status.state as BrowserPermission;
      if (permission === "denied") forgetMicrophoneGrant();
      onChange(permission);
    };
    status.addEventListener?.("change", changed);
    return () => status.removeEventListener?.("change", changed);
  } catch {
    return () => undefined;
  }
}

export async function primeMicrophone(): Promise<BrowserPermission> {
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream.getTracks().forEach((track) => track.stop());
    rememberMicrophoneGrant();
    return "granted";
  } catch (error) {
    const name = String((error as DOMException | undefined)?.name ?? "");
    if (/NotAllowed|Security/i.test(name)) {
      forgetMicrophoneGrant();
      return "denied";
    }
    return "prompt";
  }
}

export async function microphoneAlreadyGranted(): Promise<boolean> {
  return (await readJarvisPermissions()).microphone === "granted";
}
