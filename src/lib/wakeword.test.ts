import { afterEach, describe, expect, it, vi } from "vitest";
import { commandAfterWake, startWake, stopWake, WAKE_COMMAND_GRACE_MS } from "./wakeword";

class FakeSpeechRecognition {
  static instance: FakeSpeechRecognition | null = null;
  static instances: FakeSpeechRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();

  constructor() {
    FakeSpeechRecognition.instance = this;
    FakeSpeechRecognition.instances.push(this);
  }

  emit(text: string, isFinal = false) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: text }, isFinal }],
    });
  }
}

describe("wake command capture", () => {
  afterEach(() => {
    stopWake();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSpeechRecognition.instance = null;
    FakeSpeechRecognition.instances = [];
  });

  it("preserves a command spoken in the same breath", () => {
    expect(commandAfterWake("Hey Jarvis, add milk to my to-do list"))
      .toBe("add milk to my to-do list");
  });

  it("returns an empty command for a bare wake phrase", () => {
    expect(commandAfterWake("jarvis")).toBe("");
  });

  it("acknowledges an interim wake word immediately, then preserves the command grace window", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });
    const detected = vi.fn();
    const delivered = vi.fn();

    startWake(delivered, undefined, detected);
    FakeSpeechRecognition.instance?.emit("hey jarvis");

    expect(detected).toHaveBeenCalledWith("hey jarvis");
    expect(delivered).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAKE_COMMAND_GRACE_MS - 1);
    expect(delivered).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(delivered).toHaveBeenCalledWith("hey jarvis");
  });

  it("ignores a final wake result emitted after that recognizer was stopped", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });
    const delivered = vi.fn();

    startWake(delivered);
    const first = FakeSpeechRecognition.instance;
    stopWake();

    first?.emit("hey jarvis", true);
    expect(delivered).not.toHaveBeenCalled();
  });

  it("does not let a delayed old onend spawn a third recognizer after re-arm", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });

    startWake(vi.fn());
    const first = FakeSpeechRecognition.instance;
    stopWake();
    startWake(vi.fn());
    const second = FakeSpeechRecognition.instance;

    first?.onend?.();
    vi.advanceTimersByTime(120);

    expect(FakeSpeechRecognition.instance).toBe(second);
    expect(FakeSpeechRecognition.instances).toEqual([first, second]);
  });

  it("keeps standby visibly active while the browser rotates recognition sessions", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });
    const state = vi.fn();

    startWake(vi.fn(), state);
    expect(state).toHaveBeenLastCalledWith(true);
    FakeSpeechRecognition.instance?.onend?.();
    expect(state).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(120);
    expect(state).not.toHaveBeenCalledWith(false);
    expect(state).toHaveBeenLastCalledWith(true);
  });

  it("reports inactive and permits a later retry when recognizer startup throws", () => {
    class ThrowingSpeechRecognition extends FakeSpeechRecognition {
      start = vi.fn(() => { throw new Error("audio service unavailable"); });
    }
    vi.stubGlobal("window", { webkitSpeechRecognition: ThrowingSpeechRecognition });
    const state = vi.fn();

    startWake(vi.fn(), state);
    expect(state).toHaveBeenLastCalledWith(false);

    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });
    startWake(vi.fn(), state);
    expect(state).toHaveBeenLastCalledWith(true);
  });

  it("reports inactive when the browser revokes wake-listener permission", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeSpeechRecognition });
    const state = vi.fn();

    startWake(vi.fn(), state);
    FakeSpeechRecognition.instance?.onerror?.({ error: "not-allowed" });

    expect(state).toHaveBeenLastCalledWith(false);
  });

  it("waits for the native recognizer start event before reporting standby ready", () => {
    class DelayedSpeechRecognition extends FakeSpeechRecognition {
      start = vi.fn();
    }
    vi.stubGlobal("window", { webkitSpeechRecognition: DelayedSpeechRecognition });
    const state = vi.fn();

    startWake(vi.fn(), state);
    expect(state).not.toHaveBeenCalledWith(true);
    FakeSpeechRecognition.instance?.onstart?.();
    expect(state).toHaveBeenLastCalledWith(true);
  });
});
