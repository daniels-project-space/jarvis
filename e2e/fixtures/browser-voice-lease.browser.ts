import { tryAcquireBrowserVoiceLease, type BrowserVoiceLease } from "../../src/lib/browser-voice-lease";
import { createStandbyListenerClientId } from "../../src/lib/standby-listener-lease";

const frame = new URL(window.location.href).searchParams.get("frame") ?? "unknown";
const standbyListenerClient = createStandbyListenerClientId();
let lease: BrowserVoiceLease | null = null;
let stream: MediaStream | null = null;

document.body.innerHTML = `
  <main aria-label="${frame} voice fixture">
    <h1>${frame} Jarvis</h1>
    <output aria-label="Standby listener client">${standbyListenerClient ?? "unavailable"}</output>
    <output aria-label="Live microphone status">idle</output>
    <button type="button" aria-label="Start live listening">Start live listening</button>
    <button type="button" aria-label="Stop live listening" disabled>Stop live listening</button>
  </main>
`;

const statusElement = document.querySelector<HTMLOutputElement>("output[aria-label='Live microphone status']");
const startButtonElement = document.querySelector<HTMLButtonElement>("button[aria-label='Start live listening']");
const stopButtonElement = document.querySelector<HTMLButtonElement>("button[aria-label='Stop live listening']");
if (!statusElement || !startButtonElement || !stopButtonElement) throw new Error("voice fixture controls are missing");
const status = statusElement;
const startButton = startButtonElement;
const stopButton = stopButtonElement;

function setStatus(value: string) {
  status.value = value;
  status.textContent = value;
}

async function releaseLive() {
  const currentLease = lease;
  lease = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  stopButton.disabled = true;
  if (currentLease) await currentLease.release();
}

async function startLive() {
  if (lease) return;
  setStatus("connecting");
  const outcome = await tryAcquireBrowserVoiceLease();
  if (outcome.status !== "acquired") {
    setStatus(outcome.status);
    return;
  }
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    lease = outcome.lease;
    stream = microphone;
    stopButton.disabled = false;
    setStatus("live");
  } catch {
    await outcome.lease.release();
    setStatus("microphone failed");
  }
}

startButton.addEventListener("click", () => { void startLive(); });
stopButton.addEventListener("click", () => {
  void releaseLive().then(() => setStatus("stopped"));
});
window.addEventListener("pagehide", () => { void releaseLive(); });
