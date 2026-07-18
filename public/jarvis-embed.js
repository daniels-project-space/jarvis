// JARVIS everywhere — one script tag on any of Daniel's internal apps:
//   <script src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js" defer></script>
// The top-level host owns wake recognition. Browsers routinely deny a hidden
// cross-origin iframe's microphone request even when `allow="microphone"` is
// present, so transcripts are forwarded into the canonical Jarvis client.
(function () {
  if (window.__jarvisEmbed) return;
  window.__jarvisEmbed = 1;
  var ORIGIN = "https://jarvis-orcin-six.vercel.app";
  if (location.origin === ORIGIN) return;

  var release = "";
  try {
    release = new URL(document.currentScript && document.currentScript.src).searchParams.get("v") || "";
  } catch {}

  var visible = false;
  var ready = false;
  var pendingCommands = [];
  var speechBlocked = false;
  var liveBlocked = false;
  var recognition = null;
  var recognitionWanted = true;
  var recognitionNeedsGesture = false;
  var wakeEnablePending = false;
  var restartTimer = null;
  var commandTimer = null;
  var commandModeUntil = 0;
  var pendingTranscript = "";
  var lastCommand = { text: "", at: 0 };
  var WAKE_RESTART_MS = 120;
  var COMMAND_GRACE_MS = 950;
  var FOLLOW_UP_MS = 12_000;
  var SPEAKER_TAIL_MS = 800;

  var f = document.createElement("iframe");
  f.src = ORIGIN + "/embed" + (release ? "?v=" + encodeURIComponent(release) : "");
  f.title = "JARVIS";
  f.allow = "microphone; autoplay; clipboard-write; display-capture";
  f.style.cssText =
    "position:fixed;bottom:8px;right:8px;width:min(460px,calc(100vw - 16px));height:min(520px,calc(100vh - 16px));border:0;" +
    "border-radius:28px;z-index:2147483000;background:#05070d;color-scheme:dark;" +
    "box-shadow:none;transition:opacity .2s ease,transform .28s cubic-bezier(.22,1,.36,1);" +
    "opacity:0;transform:translateY(14px);pointer-events:none;";

  function post(message) {
    if (f.contentWindow) f.contentWindow.postMessage(message, ORIGIN);
  }

  function mount() {
    if (!f.isConnected && document.body) {
      document.body.appendChild(f);
      try {
        var url = new URL(location.href);
        var command = url.searchParams.get("jarvis");
        if (command) {
          url.searchParams.delete("jarvis");
          history.replaceState(history.state, "", url.pathname + url.search + url.hash);
          ask(command);
        }
      } catch {}
    }
  }

  function wakeState(listening, reason) {
    f.dataset.jarvisWake = listening ? "listening" : reason || "idle";
    post({ jarvis: "host-wake-state", listening: Boolean(listening), reason: reason || null });
    try {
      window.dispatchEvent(new CustomEvent("jarvis:wake-state", {
        detail: { listening: Boolean(listening), reason: reason || null },
      }));
    } catch {}
  }

  function show() {
    mount();
    visible = true;
    f.style.opacity = "1";
    f.style.transform = "translateY(0)";
    f.style.pointerEvents = "auto";
    post({ jarvis: "host-show" });
    if (navigator.userActivation && navigator.userActivation.isActive) enableWakeFromGesture();
  }

  function hide() {
    visible = false;
    commandModeUntil = 0;
    pendingTranscript = "";
    if (commandTimer) clearTimeout(commandTimer);
    commandTimer = null;
    f.style.opacity = "0";
    f.style.transform = "translateY(14px)";
    f.style.pointerEvents = "none";
    post({ jarvis: "host-hide" });
  }

  function flushCommands() {
    if (!ready || !f.contentWindow) return;
    while (pendingCommands.length) {
      post({ jarvis: "host-command", text: pendingCommands.shift() });
    }
  }

  function ask(text) {
    var command = String(text || "").trim().slice(0, 4000);
    if (!command) return;
    pendingCommands.push(command);
    show();
    flushCommands();
  }

  function speechRecognitionClass() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function recognitionAllowed() {
    return recognitionWanted
      && !speechBlocked
      && !liveBlocked
      && document.visibilityState === "visible";
  }

  function pauseRecognition(reason) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    var active = recognition;
    recognition = null;
    if (active) {
      try { active.abort(); } catch {}
    }
    wakeState(false, reason || "paused");
  }

  function scheduleRecognition(delay) {
    if (restartTimer) clearTimeout(restartTimer);
    if (!recognitionAllowed() || recognitionNeedsGesture) return;
    restartTimer = setTimeout(function () {
      restartTimer = null;
      startRecognition(false);
    }, delay == null ? WAKE_RESTART_MS : delay);
  }

  function commandAfterWake(text) {
    return String(text || "")
      .replace(/^.*?\b(?:hey\s+)?jarvis\b[\s,.:;!?-]*/i, "")
      .trim();
  }

  function deliverCommand(text) {
    var command = String(text || "").trim().slice(0, 4000);
    pendingTranscript = "";
    if (commandTimer) clearTimeout(commandTimer);
    commandTimer = null;
    commandModeUntil = 0;
    if (!command) return;
    var normalized = command.toLowerCase().replace(/\s+/g, " ");
    if (normalized === lastCommand.text && Date.now() - lastCommand.at < 2500) return;
    lastCommand = { text: normalized, at: Date.now() };
    ask(command);
  }

  function stageTranscript(text, isFinal) {
    var transcript = String(text || "").trim();
    if (!transcript) return;
    pendingTranscript = transcript;
    post({ jarvis: "host-transcript", text: transcript });
    if (commandTimer) clearTimeout(commandTimer);
    if (isFinal) {
      deliverCommand(transcript);
      return;
    }
    commandTimer = setTimeout(function () {
      deliverCommand(pendingTranscript);
    }, COMMAND_GRACE_MS);
  }

  function handleRecognitionResult(event) {
    if (speechBlocked || liveBlocked) return;
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var result = event.results[i];
      var text = String(result[0] && result[0].transcript || "").trim();
      if (!text) continue;
      if (/\b(?:hey\s+)?jarvis\b/i.test(text)) {
        show();
        commandModeUntil = Date.now() + FOLLOW_UP_MS;
        post({ jarvis: "host-wake-detected" });
        var sameBreath = commandAfterWake(text);
        if (sameBreath) stageTranscript(sameBreath, result.isFinal);
        else if (result.isFinal) {
          pendingTranscript = "";
          if (commandTimer) clearTimeout(commandTimer);
          commandTimer = null;
        }
        continue;
      }
      if (visible && Date.now() < commandModeUntil) {
        stageTranscript(text, result.isFinal);
      }
    }
  }

  function startRecognition(fromGesture) {
    var Recognition = speechRecognitionClass();
    if (!Recognition) {
      wakeState(false, "unsupported");
      return;
    }
    if (recognition || !recognitionAllowed()) return;
    if (recognitionNeedsGesture && !fromGesture) return;
    var r = new Recognition();
    recognition = r;
    r.lang = "en-GB";
    r.continuous = true;
    r.interimResults = true;
    r.onstart = function () {
      if (recognition !== r) return;
      recognitionNeedsGesture = false;
      wakeState(true);
    };
    r.onresult = handleRecognitionResult;
    r.onerror = function (event) {
      if (recognition !== r) return;
      if (event && (event.error === "not-allowed" || event.error === "service-not-allowed")) {
        recognitionNeedsGesture = true;
        wakeState(false, "permission");
      }
    };
    r.onend = function () {
      if (recognition !== r) return;
      recognition = null;
      wakeState(false, recognitionNeedsGesture ? "permission" : "restarting");
      scheduleRecognition(WAKE_RESTART_MS);
    };
    try {
      r.start();
    } catch {
      recognition = null;
      scheduleRecognition(WAKE_RESTART_MS);
    }
  }

  function enableWakeFromGesture() {
    recognitionWanted = true;
    if ((recognition && !recognitionNeedsGesture) || wakeEnablePending) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      recognitionNeedsGesture = false;
      startRecognition(true);
      return;
    }
    wakeEnablePending = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      wakeEnablePending = false;
      recognitionNeedsGesture = false;
      startRecognition(true);
    }).catch(function () {
      wakeEnablePending = false;
      recognitionNeedsGesture = true;
      wakeState(false, "permission");
    });
  }

  window.JARVIS = {
    show: show,
    hide: hide,
    ask: ask,
    enableWake: enableWakeFromGesture,
    toggle: function () {
      enableWakeFromGesture();
      if (visible) hide();
      else show();
    },
    get visible() {
      return visible;
    },
    get wake() {
      return {
        supported: Boolean(speechRecognitionClass()),
        listening: Boolean(recognition),
        needsPermission: recognitionNeedsGesture,
        mode: Date.now() < commandModeUntil ? "command" : "wake",
      };
    },
  };

  window.addEventListener("message", function (event) {
    if (event.origin !== ORIGIN || event.source !== f.contentWindow) return;
    var data = event.data || {};
    if (data.jarvis === "ready") {
      ready = true;
      flushCommands();
      wakeState(Boolean(recognition), recognitionNeedsGesture ? "permission" : null);
    } else if (data.jarvis === "wake" || data.jarvis === "notify") {
      show();
    } else if (data.jarvis === "hide") {
      hide();
    } else if (data.jarvis === "speech-start") {
      speechBlocked = true;
      commandModeUntil = 0;
      pauseRecognition("speaking");
    } else if (data.jarvis === "speech-end") {
      if (!speechBlocked) return;
      speechBlocked = false;
      if (visible) commandModeUntil = Date.now() + FOLLOW_UP_MS;
      scheduleRecognition(SPEAKER_TAIL_MS);
    } else if (data.jarvis === "live-start") {
      liveBlocked = true;
      pauseRecognition("live");
    } else if (data.jarvis === "live-end") {
      if (!liveBlocked) return;
      liveBlocked = false;
      scheduleRecognition(300);
    } else if (data.jarvis === "context-request" && typeof data.id === "string") {
      var selection = "";
      var text = "";
      try {
        selection = String(window.getSelection ? window.getSelection() : "").slice(0, 1800);
        text = String(document.body ? document.body.innerText : "").slice(0, 7000);
      } catch {}
      post({
        jarvis: "context-response",
        id: data.id,
        context: { url: location.href, title: document.title, selection: selection, text: text },
      });
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") scheduleRecognition(0);
    else pauseRecognition("background");
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      mount();
      startRecognition(false);
    });
  } else {
    mount();
    startRecognition(false);
  }
})();
