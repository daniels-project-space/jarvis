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
      try {
        if (localStorage.getItem("jarvis_microphone_granted") === "1") microphone = "granted";
      } catch {
        /* storage may be disabled */
      }
    }
  }
  return { microphone, notifications: notificationState() };
}

export async function primeMicrophone(): Promise<BrowserPermission> {
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream.getTracks().forEach((track) => track.stop());
    try { localStorage.setItem("jarvis_microphone_granted", "1"); } catch { /* storage may be disabled */ }
    return "granted";
  } catch (error) {
    const name = String((error as DOMException | undefined)?.name ?? "");
    if (/NotAllowed|Security/i.test(name)) {
      try { localStorage.removeItem("jarvis_microphone_granted"); } catch { /* storage may be disabled */ }
      return "denied";
    }
    return "prompt";
  }
}

export async function microphoneAlreadyGranted(): Promise<boolean> {
  return (await readJarvisPermissions()).microphone === "granted";
}
