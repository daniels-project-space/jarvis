import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const loaderSource = readFileSync(new URL("../../public/jarvis-embed.js", import.meta.url), "utf8");
const JARVIS_ORIGIN = "https://jarvis-orcin-six.vercel.app";

type LoaderListener = (event: unknown) => void;
type JarvisApi = {
  show: () => void;
  interrupt: () => void;
  visible: boolean;
  wake: { listening: boolean; needsPermission: boolean };
};
type LoaderWindow = {
  JARVIS: JarvisApi;
  SpeechRecognition: unknown;
  addEventListener: (name: string, listener: LoaderListener) => void;
  dispatchEvent: ReturnType<typeof vi.fn>;
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
  contentWindow?: { postMessage: ReturnType<typeof vi.fn> };
  dataset: Record<string, string>;
  isConnected: boolean;
  onclick?: (() => void) | null;
  remove: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  src?: string;
  style: Record<string, string> & { cssText?: string };
  textContent?: string;
  title?: string;
  type?: string;
};

function createLoader(options: { denyFirstRecognition?: boolean; hostNodes?: unknown[]; hostById?: Record<string, unknown> } = {}) {
  const messages: unknown[] = [];
  const listeners = new Map<string, LoaderListener[]>();
  const frameWindow = { postMessage: vi.fn((message: unknown) => messages.push(message)) };
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
      style: {} as Record<string, string>,
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
    getElementById: vi.fn((id: string) => options.hostById?.[id] ?? null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => options.hostNodes ?? []),
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
    dispatchEvent: vi.fn((event: { type?: string }) => {
      for (const listener of listeners.get(event?.type ?? "") ?? []) listener(event);
      return true;
    }),
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
    CustomEvent: class {
      detail: unknown;
      constructor(public type: string, init: { detail?: unknown }) {
        this.detail = init?.detail;
      }
    },
    URL,
    clearTimeout,
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
    expect(controls?.children[1].attributes["aria-pressed"]).toBe("true");
  });

  it("captures the wake word in the top-level page and forwards the command", () => {
    const harness = createLoader();
    expect(harness.frame.src).toBe(`${JARVIS_ORIGIN}/embed?v=test-release`);
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

  it("keeps password and payment controls out of the host-context contract", () => {
    const secret = {
      tagName: "INPUT",
      type: "password",
      name: "payment_card_number",
      id: "checkout-card",
      dataset: {},
      closest: () => null,
      getAttribute: (name: string) => name === "name" ? "payment_card_number" : null,
    };
    const harness = createLoader({ hostNodes: [secret] });
    harness.listeners.get("message")?.[0]?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: { jarvis: "ready" },
    });

    const contextMessage = harness.messages.find((message: any) => message?.jarvis === "host-context") as any;
    expect(contextMessage.context.elements).toEqual([]);
    expect(contextMessage.context.text).toBe("");
    expect(loaderSource).not.toContain("document.body ? document.body.innerText");
    expect(loaderSource).toContain("function isSensitiveElement(element)");
    expect(loaderSource).toContain("tab to it and press Enter");
  });

  it("rejects sensitive exact targets and their ancestors before any host-local or generic action path", async () => {
    const paymentForm = {
      tagName: "FORM",
      dataset: {},
      getAttribute: (name: string) => name === "aria-label" ? "Bank payment" : null,
      parentElement: null,
    };
    const submit = {
      tagName: "BUTTON",
      id: "billing-submit",
      dataset: {},
      click: vi.fn(),
      style: {} as Record<string, string>,
      closest: () => null,
      getAttribute: () => null,
      parentElement: paymentForm,
    };
    const harness = createLoader({ hostById: { "billing-submit": submit } });
    const receive = harness.listeners.get("message")?.[0];
    const localHandler = vi.fn((event: any) => {
      event.detail.handled = true;
      event.detail.result = { ok: true, detail: "This must never run." };
    });
    harness.listeners.set("jarvis:host-action", [localHandler]);
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    const hostContext = harness.messages.find((message: any) => message?.jarvis === "host-context") as any;
    harness.window.dispatchEvent.mockClear();

    for (const action of ["focus", "activate", "show_widget"]) {
      receive?.({
        origin: JARVIS_ORIGIN,
        source: harness.frameWindow,
        data: {
          jarvis: "host-action",
          action: {
            id: `private-${action}`,
            action,
            target: "billing-submit",
            hostId: hostContext.context.hostId,
            expectedUrl: "https://project-hub.test/dashboard?view=work#today",
          },
        },
      });
    }
    await Promise.resolve();

    for (const action of ["focus", "activate", "show_widget"]) {
      expect(harness.messages).toContainEqual({
        jarvis: "host-action-result",
        id: `private-${action}`,
        ok: false,
        detail: "I cannot act on that private control.",
      });
    }
    expect(submit.click).not.toHaveBeenCalled();
    expect(localHandler).not.toHaveBeenCalled();
    expect(harness.window.dispatchEvent).not.toHaveBeenCalled();
    expect(submit.style.outline).toBeUndefined();

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: {
        jarvis: "host-action",
        action: {
          id: "private-edit",
          action: "edit",
          instruction: "edit this payment button",
          expectedUrl: "https://project-hub.test/dashboard?view=work#today",
        },
      },
    });
    const preventDefault = vi.fn();
    harness.listeners.get("click")?.[0]?.({
      target: submit,
      preventDefault,
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    });
    await Promise.resolve();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.messages).not.toContainEqual(expect.objectContaining({ jarvis: "host-command" }));
  });

  it("lets a host synchronously restore an allowlisted missing widget without opening generic target paths", async () => {
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    const restored = vi.fn();
    harness.listeners.set("jarvis:host-action", [(event: any) => {
      if (event.detail.action.action !== "show_widget" || event.detail.action.target !== "wealth") return;
      restored();
      event.detail.handled = true;
      event.detail.result = { ok: true, detail: "Wealth restored." };
    }]);

    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    const hostContext = harness.messages.find((message: any) => message?.jarvis === "host-context") as any;

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: {
        jarvis: "host-action",
        action: {
          id: "restore-wealth",
          action: "show_widget",
          target: "wealth",
          hostId: hostContext.context.hostId,
          expectedUrl: "https://project-hub.test/dashboard?view=work#today",
        },
      },
    });
    await Promise.resolve();

    expect(restored).toHaveBeenCalledOnce();
    expect(harness.messages).toContainEqual({
      jarvis: "host-action-result",
      id: "restore-wealth",
      ok: true,
      detail: "Wealth restored.",
    });
  });

  it("does not offer the missing-target extension to focus, activate, or sensitive widget names", async () => {
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    const localHandler = vi.fn((event: any) => {
      event.detail.handled = true;
    });
    harness.listeners.set("jarvis:host-action", [localHandler]);

    for (const [id, action, target] of [
      ["missing-focus", "focus", "wealth"],
      ["missing-activate", "activate", "wealth"],
      ["missing-payment", "show_widget", "payment_card"],
    ]) {
      receive?.({
        origin: JARVIS_ORIGIN,
        source: harness.frameWindow,
        data: { jarvis: "host-action", action: { id, action, target, expectedUrl: "https://project-hub.test/dashboard?view=work#today" } },
      });
    }
    await Promise.resolve();

    expect(localHandler).not.toHaveBeenCalled();
    expect(harness.messages).toContainEqual({ jarvis: "host-action-result", id: "missing-focus", ok: false, detail: "I could not find that control on this page." });
    expect(harness.messages).toContainEqual({ jarvis: "host-action-result", id: "missing-activate", ok: false, detail: "I could not find that control on this page." });
    expect(harness.messages).toContainEqual({ jarvis: "host-action-result", id: "missing-payment", ok: false, detail: "I could not find that control on this page." });
  });

  it("requires a synchronous local acknowledgement for a missing allowlisted widget", async () => {
    const harness = createLoader();
    const receive = harness.listeners.get("message")?.[0];
    receive?.({ origin: JARVIS_ORIGIN, source: harness.frameWindow, data: { jarvis: "ready" } });
    const hostContext = harness.messages.find((message: any) => message?.jarvis === "host-context") as any;

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: {
        jarvis: "host-action",
        action: {
          id: "unhandled-wealth",
          action: "show_widget",
          target: "wealth",
          hostId: hostContext.context.hostId,
          expectedUrl: "https://project-hub.test/dashboard?view=work#today",
        },
      },
    });
    await Promise.resolve();

    expect(harness.messages).toContainEqual({
      jarvis: "host-action-result",
      id: "unhandled-wealth",
      ok: false,
      detail: "I could not find that control on this page.",
    });
  });

  it("fails closed for an exact id nested deeply inside a hidden private region", async () => {
    let ancestor: any = {
      tagName: "SECTION",
      hidden: true,
      dataset: {},
      getAttribute: () => null,
      parentElement: null,
    };
    // A fixed shallow traversal would make this control reachable after a
    // host adds ordinary layout wrappers around a private checkout section.
    for (let index = 0; index < 20; index++) {
      ancestor = {
        tagName: "DIV",
        dataset: {},
        getAttribute: () => null,
        parentElement: ancestor,
      };
    }
    const privateButton = {
      tagName: "BUTTON",
      id: "deep-private-action",
      dataset: {},
      click: vi.fn(),
      getAttribute: () => null,
      parentElement: ancestor,
    };
    const harness = createLoader({ hostById: { "deep-private-action": privateButton } });
    const receive = harness.listeners.get("message")?.[0];

    receive?.({
      origin: JARVIS_ORIGIN,
      source: harness.frameWindow,
      data: {
        jarvis: "host-action",
        action: {
          id: "deep-private-focus",
          action: "focus",
          target: "deep-private-action",
          expectedUrl: "https://project-hub.test/dashboard?view=work#today",
        },
      },
    });
    await Promise.resolve();

    expect(harness.messages).toContainEqual({
      jarvis: "host-action-result",
      id: "deep-private-focus",
      ok: false,
      detail: "I cannot act on that private control.",
    });
    expect(privateButton.click).not.toHaveBeenCalled();
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
