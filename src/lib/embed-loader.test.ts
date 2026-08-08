import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const loaderSource = readFileSync(new URL("../../public/jarvis-embed.js", import.meta.url), "utf8");
const JARVIS_ORIGIN = "https://jarvis-orcin-six.vercel.app";

type LoaderListener = (event: unknown) => void;
type JarvisApi = {
  ask: (text: string) => void;
  show: () => void;
  interrupt: () => void;
  visible: boolean;
  wake: { listening: boolean; needsPermission: boolean };
};
type LoaderWindow = {
  JARVIS: JarvisApi;
  SpeechRecognition: unknown;
  addEventListener: (name: string, listener: LoaderListener) => void;
  dispatchEvent: (event: unknown) => void;
  getSelection: () => string;
  history: { state: null };
  location: { href: string; origin: string; assign: ReturnType<typeof vi.fn> };
  navigator: {
    mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> };
    userActivation: { isActive: boolean };
  };
  window: LoaderWindow;
};

type FakeElement = {
  allow?: string;
  attributes: Record<string, string>;
  appendChild: (child: FakeElement) => FakeElement;
  children: FakeElement[];
  contentWindow?: {
    location: { origin: string };
    postMessage: ReturnType<typeof vi.fn>;
  };
  dataset: Record<string, string>;
  isConnected: boolean;
  onclick?: (() => void) | null;
  onload?: (() => void) | null;
  remove: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  src?: string;
  style: Record<string, string> & { cssText?: string };
  textContent?: string;
  title?: string;
  type?: string;
};

function createLoader(options: {
  denyFirstRecognition?: boolean;
  frameOrigin?: string;
} = {}) {
  const messages: unknown[] = [];
  const listeners = new Map<string, LoaderListener[]>();
  const frameWindow = {
    location: { origin: options.frameOrigin ?? JARVIS_ORIGIN },
    postMessage: vi.fn((message: unknown) => messages.push(message)),
  };
  const createdElements: FakeElement[] = [];
  const fakeElement = (): FakeElement => {
    const attributes: Record<string, string> = {};
    const element = {
      attributes,
      appendChild(child: FakeElement) {
        this.children.push(child);
        return child;
      },
      children: [],
      dataset: {},
      isConnected: false,
      remove: vi.fn(),
      setAttribute: vi.fn((name: string, value: string) => { attributes[name] = value; }),
      style: {},
    } as FakeElement;
    return element;
  };
  const frame = {
    ...fakeElement(),
    allow: "",
    contentWindow: frameWindow,
    src: "",
    title: "",
  } as FakeElement;
  const document = {
    body: {
      innerText: "Project Hub",
      appendChild: vi.fn((node: FakeElement) => { node.isConnected = true; }),
    },
    currentScript: {
      src: `${JARVIS_ORIGIN}/jarvis-embed.js?v=test-release`,
      dataset: { jarvisApp: "project-hub" },
    },
    createElement: vi.fn((tag: string) => {
      const node = tag === "iframe" ? frame : fakeElement();
      createdElements.push(node);
      return node;
    }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn((name: string, listener: LoaderListener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
    readyState: "complete",
    visibilityState: "visible",
  };
  let denyFirst = options.denyFirstRecognition === true;
  class FakeRecognition {
    static instances: FakeRecognition[] = [];
    continuous = false;
    interimResults = false;
    lang = "";
    onstart: (() => void) | null = null;
    onresult: ((event: {
      resultIndex: number;
      results: Array<Array<{ transcript: string; confidence?: number }> & { isFinal: boolean }>;
    }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    abort = vi.fn(() => this.onend?.());

    constructor() { FakeRecognition.instances.push(this); }

    start() {
      if (denyFirst) {
        denyFirst = false;
        this.onerror?.({ error: "not-allowed" });
        this.onend?.();
        return;
      }
      this.onstart?.();
    }

    result(text: string, isFinal: boolean, confidence = 0.9) {
      const result = Object.assign([{ transcript: text, confidence }], { isFinal });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
  }
  const microphone = { getTracks: () => [{ stop: vi.fn() }] };
  const navigator = {
    mediaDevices: { getUserMedia: vi.fn(async () => microphone) },
    userActivation: { isActive: false },
  };
  const windowObject = {
    SpeechRecognition: FakeRecognition,
    addEventListener: vi.fn((name: string, listener: LoaderListener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
    dispatchEvent: vi.fn(),
    getSelection: () => "",
    history: { state: null },
    location: {
      href: "https://project-hub.test/dashboard?view=work#today",
      origin: "https://project-hub.test",
      assign: vi.fn(),
    },
    navigator,
  } as unknown as LoaderWindow;
  windowObject.window = windowObject;
  const context = {
    CustomEvent: class { constructor(public type: string, public init: unknown) {} },
    URL,
    clearTimeout,
    Date,
    document,
    history: windowObject.history,
    location: windowObject.location,
    navigator,
    setTimeout,
    window: windowObject,
  };
  runInNewContext(loaderSource, context);
  return { createdElements, FakeRecognition, frame, frameWindow, listeners, messages, navigator, window: windowObject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Project Hub Jarvis loader", () => {
  it("waits for the iframe to leave inherited about:blank before posting", () => {
    vi.useFakeTimers();
    const harness = createLoader({ frameOrigin: "https://project-hub.test" });
    harness.frameWindow.postMessage.mockClear();
    harness.messages.splice(0);

    // Browsers may report an initial same-origin about:blank load after the
    // iframe is attached. It cannot receive a Jarvis-targeted message.
    harness.frame.onload?.();
    vi.advanceTimersByTime(500);
    expect(harness.frameWindow.postMessage).not.toHaveBeenCalled();

    harness.frameWindow.location.origin = JARVIS_ORIGIN;
    harness.frame.onload?.();

    expect(harness.frameWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ jarvis: "host-ready-probe" }),
      JARVIS_ORIGIN,
    );
  });

  it("bounds pre-ready commands and discards them after the handoff TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    const harness = createLoader();
    for (let index = 1; index <= 6; index += 1) harness.window.JARVIS.ask(`command ${index}`);
    const receive = harness.listeners.get("message")?.[0];
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    expect(harness.messages.filter((message) => (
      message as { jarvis?: string }
    ).jarvis === "host-command")).toEqual([
      { jarvis: "host-command", text: "command 3" },
      { jarvis: "host-command", text: "command 4" },
      { jarvis: "host-command", text: "command 5" },
      { jarvis: "host-command", text: "command 6" },
    ]);

    const staleHarness = createLoader();
    staleHarness.window.JARVIS.ask("stale command");
    vi.advanceTimersByTime(30_001);
    staleHarness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: staleHarness.frameWindow,
      data: { jarvis: "ready" },
    });
    expect(staleHarness.messages).not.toContainEqual({ jarvis: "host-command", text: "stale command" });
  });

  it("holds commands across an iframe reload until that document acknowledges a fresh probe", () => {
    vi.useFakeTimers();
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    harness.messages.splice(0);

    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "unloading" } });
    harness.window.JARVIS.ask("command during reload");
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    expect(harness.messages).not.toContainEqual({ jarvis: "host-command", text: "command during reload" });

    harness.frame.onload?.();
    const probe = harness.messages.find((message) => (
      message as { jarvis?: string }
    ).jarvis === "host-ready-probe") as { jarvis: string; probe: number } | undefined;
    expect(probe?.probe).toBeTypeOf("number");

    expect(harness.messages).not.toContainEqual({ jarvis: "host-command", text: "command during reload" });

    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    expect(harness.messages).not.toContainEqual({ jarvis: "host-command", text: "command during reload" });

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "ready", probe: probe?.probe },
    });
    expect(harness.messages.filter((message) => (
      message as { jarvis?: string }
    ).jarvis === "host-command")).toEqual([
      { jarvis: "host-command", text: "command during reload" },
    ]);
  });

  it("mounts one universal Jarvis control with the visual selector beside it", () => {
    const harness = createLoader();
    const controls = harness.createdElements.find((element) => "data-jarvis-universal-controls" in element.attributes);

    expect(controls).toBeDefined();
    expect(controls?.attributes["data-jarvis-edit-ui"]).toBe("controls");
    expect(controls?.children).toHaveLength(2);
    expect(controls?.children[0].attributes["aria-label"]).toContain("always listening");
    expect(controls?.children[1].attributes["aria-label"]).toContain("Select an element");
    expect(controls?.children[1].onclick).toBeTypeOf("function");

    controls?.children[1].onclick?.();
    const editCard = harness.createdElements.find((element) => element.dataset.jarvisEditUi === "card");
    expect(editCard?.style.cssText).toContain("bottom:72px");
  });

  it("defaults to a compact iframe and accepts only trusted semantic layout requests", () => {
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];

    expect(harness.frame.style.cssText).toContain("width:min(320px,calc(100vw - 16px))");
    expect(harness.frame.style.cssText).toContain("height:min(190px,calc(100vh - 82px))");

    receive?.({
      origin: "https://hostile.example",
      source: harness.frameWindow,
      data: { jarvis: "layout", expanded: true },
    });
    expect(harness.frame.style.width).toBeUndefined();

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "layout", expanded: true, width: "100vw" },
    });
    expect(harness.frame.style.width).toBe("min(460px,calc(100vw - 16px))");
    expect(harness.frame.style.height).toBe("min(520px,calc(100vh - 82px))");

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "layout", expanded: false },
    });
    expect(harness.frame.style.width).toBe("min(320px,calc(100vw - 16px))");
    expect(harness.frame.style.height).toBe("min(190px,calc(100vh - 82px))");
  });

  it("shows bounded realtime work stages in the collapsed host control", () => {
    const harness = createLoader();
    const controls = harness.createdElements.find((element) => "data-jarvis-universal-controls" in element.attributes);
    const button = controls?.children[0];
    const label = button?.children[1];
    const track = button?.children[2];
    const fill = track?.children[0];

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "status", phase: "thinking", progress: 0.32 },
    });
    expect(button?.attributes["aria-label"]).toBe("Jarvis is thinking");
    expect(label?.textContent).toBe("THINKING");
    expect(track?.style.opacity).toBe("1");
    expect(fill?.style.transform).toBe("scaleX(0.32)");

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "status", phase: "researching", progress: 0.24 },
    });
    expect(label?.textContent).toBe("RESEARCHING");
    expect(fill?.style.transform).toBe("scaleX(0.24)");

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "status", phase: "responding", progress: 0.72 },
    });
    expect(label?.textContent).toBe("RESPONDING");
    expect(fill?.style.transform).toBe("scaleX(0.72)");

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "status", phase: "buffering", progress: 0.86 },
    });
    expect(label?.textContent).toBe("BUFFERING");
    expect(fill?.style.transform).toBe("scaleX(0.86)");

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "status", phase: "online", progress: 1 },
    });
    expect(label?.textContent).toBe("JARVIS");
    expect(track?.style.opacity).toBe("0");
    expect(fill?.style.transform).toBe("scaleX(0)");
  });

  it("captures the wake word in the top-level page and forwards the command", () => {
    const harness = createLoader();
    expect(harness.frame.src).toBe(`${JARVIS_ORIGIN}/embed?v=test-release&hostOrigin=https%3A%2F%2Fproject-hub.test`);
    expect(harness.FakeRecognition.instances).toHaveLength(1);
    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "ready" },
    });

    harness.FakeRecognition.instances[0].result("Hey Jarvis, open the bitcoin chart", true);

    expect(harness.window.JARVIS.visible).toBe(true);
    expect(harness.messages).toContainEqual({ jarvis: "host-wake-detected" });
    expect(harness.messages).toContainEqual({ jarvis: "host-transcript", text: "open the bitcoin chart" });
    expect(harness.messages).toContainEqual({ jarvis: "host-command", text: "open the bitcoin chart" });
  });

  it("closes the mobile overlay immediately when the embedded X requests hide", () => {
    const harness = createLoader();
    harness.window.JARVIS.show();
    expect(harness.window.JARVIS.visible).toBe(true);
    expect(harness.frame.style.pointerEvents).toBe("auto");

    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "hide" },
    });

    expect(harness.window.JARVIS.visible).toBe(false);
    expect(harness.frame.style).toMatchObject({
      opacity: "0",
      pointerEvents: "none",
      transform: "translateY(14px)",
    });
    expect(harness.messages).toContainEqual({ jarvis: "host-hide" });
  });

  it("proactively sends route-aware host context when the iframe is ready", () => {
    const harness = createLoader();
    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "ready" },
    });

    expect(harness.messages).toContainEqual({
      jarvis: "host-context",
      context: expect.objectContaining({
        url: "https://project-hub.test/dashboard?view=work#today",
        route: "/dashboard?view=work#today",
        app: "project-hub",
        elements: [],
      }),
    });
  });

  it("executes an app navigation, acknowledges it, and supports interruption", async () => {
    vi.useFakeTimers();
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: {
        jarvis: "host-action",
        action: {
          id: "open-youtube",
          action: "open_app",
          target: "YouTube Studio AI",
          url: "https://youtube-studio-ai.vercel.app",
          expectedUrl: "https://project-hub.test/dashboard?view=work#today",
        },
      },
    });
    await Promise.resolve();

    expect(harness.messages).toContainEqual({
      jarvis: "host-action-result",
      id: "open-youtube",
      ok: true,
      detail: "Opening YouTube Studio AI.",
    });
    vi.advanceTimersByTime(620);
    expect(harness.window.location.assign).toHaveBeenCalledWith("https://youtube-studio-ai.vercel.app/");

    harness.window.JARVIS.interrupt();
    expect(harness.messages).toContainEqual({ jarvis: "host-interrupt" });
  });

  it("uses the Hub button gesture to recover from an initial permission denial", async () => {
    const harness = createLoader({ denyFirstRecognition: true });
    expect(harness.window.JARVIS.wake.needsPermission).toBe(true);

    harness.navigator.userActivation.isActive = true;
    harness.window.JARVIS.show();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(harness.FakeRecognition.instances).toHaveLength(2);
    expect(harness.window.JARVIS.wake).toMatchObject({ listening: true, needsPermission: false });
  });

  it("pauses recognition during Jarvis speech and resumes after the echo tail", () => {
    vi.useFakeTimers();
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    expect(receive).toBeTypeOf("function");

    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "speech-start" } });
    expect(harness.FakeRecognition.instances[0].abort).toHaveBeenCalledOnce();
    expect(harness.window.JARVIS.wake.listening).toBe(false);

    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "speech-end" } });
    vi.advanceTimersByTime(799);
    expect(harness.FakeRecognition.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.FakeRecognition.instances).toHaveLength(2);
    expect(harness.window.JARVIS.wake.listening).toBe(true);
  });

  it("atomically transfers live preview recognition to the trusted iframe", () => {
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    const sessionId = "voice-session-123";

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "preview-claim", sessionId },
    });

    expect(harness.FakeRecognition.instances[0].abort).toHaveBeenCalledOnce();
    expect(harness.window.JARVIS.wake.listening).toBe(false);
    expect(harness.messages).toContainEqual({ jarvis: "host-preview-grant", sessionId });

    const grantCount = harness.messages.filter(
      (message) => (message as { jarvis?: string }).jarvis === "host-preview-grant",
    ).length;
    receive?.({
      origin: "https://untrusted.example",
      source: harness.frameWindow,
      data: { jarvis: "preview-claim", sessionId: "voice-session-evil" },
    });
    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "preview-claim", sessionId: "bad id" },
    });
    expect(harness.messages.filter(
      (message) => (message as { jarvis?: string }).jarvis === "host-preview-grant",
    )).toHaveLength(grantCount);
  });

  it("does not forward an invented ambient thank-you after Jarvis speaks", () => {
    vi.useFakeTimers();
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    harness.window.JARVIS.show();
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "speech-start" } });
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "speech-end" } });
    vi.advanceTimersByTime(800);

    harness.FakeRecognition.instances[1].result("Thank you.", true, 0.99);

    expect(harness.messages).not.toContainEqual({ jarvis: "host-transcript", text: "Thank you." });
    expect(harness.messages).not.toContainEqual({ jarvis: "host-command", text: "Thank you." });
  });
});
