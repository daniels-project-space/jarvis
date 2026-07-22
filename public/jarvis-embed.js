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
  var configuredApp = "";
  try {
    var hostScript = document.currentScript;
    release = new URL(hostScript && hostScript.src).searchParams.get("v") || "";
    configuredApp = String(hostScript && hostScript.dataset && hostScript.dataset.jarvisApp || "").slice(0, 120);
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
  var HOST_ID = "host-" + (
    window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  );
  var confirmedEditTarget = null;
  var editSession = null;
  var WAKE_RESTART_MS = 120;
  var COMMAND_GRACE_MS = 950;
  var FOLLOW_UP_MS = 12_000;
  var SPEAKER_TAIL_MS = 800;

  var f = document.createElement("iframe");
  f.src = ORIGIN + "/embed" + (release ? "?v=" + encodeURIComponent(release) : "");
  f.title = "JARVIS";
  f.allow = "microphone; autoplay; clipboard-write; display-capture";
  f.style.cssText =
    "position:fixed;bottom:66px;right:8px;width:min(460px,calc(100vw - 16px));height:min(520px,calc(100vh - 82px));border:0;" +
    "border-radius:28px;z-index:2147483000;background:#05070d;color-scheme:dark;" +
    "box-shadow:none;transition:opacity .2s ease,transform .28s cubic-bezier(.22,1,.36,1);" +
    "opacity:0;transform:translateY(14px);pointer-events:none;";

  // One host-owned control in every app. Individual products no longer need
  // to reinvent a Jarvis button or remember to expose the element selector.
  // Inline `all:initial` styling prevents app CSS from corrupting the control.
  var controls = document.createElement("div");
  controls.setAttribute("data-jarvis-universal-controls", "");
  controls.setAttribute("data-jarvis-edit-ui", "controls");
  controls.style.cssText =
    "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483001;display:flex;align-items:center;gap:6px;" +
    "padding:5px;border:1px solid rgba(130,220,255,.24);border-radius:18px;background:rgba(4,9,16,.9);" +
    "box-shadow:0 14px 48px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.06);backdrop-filter:blur(18px);";
  var jarvisButton = document.createElement("button");
  jarvisButton.type = "button";
  jarvisButton.setAttribute("aria-label", "Open Jarvis; wake word is always listening");
  jarvisButton.style.cssText =
    "all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;height:38px;padding:0 12px;border-radius:13px;" +
    "cursor:pointer;color:#dff9ff;background:rgba(64,208,255,.08);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "letter-spacing:.14em;transition:background .18s ease,color .18s ease,box-shadow .18s ease;";
  var wakeDot = document.createElement("span");
  wakeDot.setAttribute("aria-hidden", "true");
  wakeDot.style.cssText =
    "all:initial;display:block;width:8px;height:8px;border-radius:999px;background:#67e8f9;" +
    "box-shadow:0 0 0 4px rgba(103,232,249,.1),0 0 16px rgba(103,232,249,.7);";
  var jarvisLabel = document.createElement("span");
  jarvisLabel.textContent = "JARVIS";
  jarvisLabel.style.cssText = "all:initial;color:inherit;font:inherit;letter-spacing:inherit";
  jarvisButton.appendChild(wakeDot);
  jarvisButton.appendChild(jarvisLabel);
  var selectorButton = document.createElement("button");
  selectorButton.type = "button";
  selectorButton.setAttribute("aria-label", "Select an element for Jarvis to inspect or change");
  selectorButton.title = "Select an element for Jarvis";
  selectorButton.textContent = "⌖";
  selectorButton.style.cssText =
    "all:unset;box-sizing:border-box;display:grid;place-items:center;width:38px;height:38px;border-radius:13px;cursor:pointer;" +
    "color:#8fdff5;background:rgba(255,255,255,.045);font:500 23px/1 system-ui,sans-serif;" +
    "transition:background .18s ease,color .18s ease,box-shadow .18s ease;";
  controls.appendChild(jarvisButton);
  controls.appendChild(selectorButton);

  function paintUniversalControls() {
    var awake = Boolean(recognition) && !speechBlocked && !liveBlocked;
    jarvisButton.setAttribute("aria-pressed", visible ? "true" : "false");
    jarvisButton.title = awake
      ? "Jarvis is always listening — say ‘Hey Jarvis’ or tap to open"
      : "Open Jarvis and enable the wake word";
    jarvisButton.style.background = visible ? "rgba(34,211,238,.18)" : "rgba(64,208,255,.08)";
    jarvisButton.style.boxShadow = visible ? "inset 0 0 0 1px rgba(103,232,249,.35)" : "none";
    wakeDot.style.background = awake ? "#67e8f9" : recognitionNeedsGesture ? "#fbbf24" : "#64748b";
    wakeDot.style.boxShadow = awake
      ? "0 0 0 4px rgba(103,232,249,.1),0 0 16px rgba(103,232,249,.7)"
      : "0 0 0 4px rgba(148,163,184,.08)";
    var selecting = Boolean(editSession);
    selectorButton.setAttribute("aria-pressed", selecting ? "true" : "false");
    selectorButton.title = selecting ? "Selection mode is on — point or tab to an element, then confirm" : "Select an element for Jarvis";
    selectorButton.style.background = selecting ? "rgba(34,211,238,.18)" : "rgba(255,255,255,.045)";
    selectorButton.style.boxShadow = selecting ? "inset 0 0 0 1px rgba(103,232,249,.42),0 0 18px rgba(34,211,238,.16)" : "none";
  }

  jarvisButton.onclick = function () {
    enableWakeFromGesture();
    if (visible) hide();
    else show();
  };
  selectorButton.onclick = function () {
    enableWakeFromGesture();
    show();
    startEditMode("");
  };

  function post(message) {
    if (f.contentWindow) f.contentWindow.postMessage(message, ORIGIN);
  }

  function compact(value, max) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function normal(value) {
    return compact(value, 500).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function escapeSelector(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, "\\$1");
  }

  function stableSelector(element) {
    if (!element || !element.tagName) return "";
    var jarvisId = element.dataset && element.dataset.jarvisId;
    if (jarvisId) return '[data-jarvis-id="' + String(jarvisId).replace(/"/g, '\\"') + '"]';
    if (element.id) return "#" + escapeSelector(element.id);
    var aria = element.getAttribute && element.getAttribute("aria-label");
    if (aria) return element.tagName.toLowerCase() + '[aria-label="' + String(aria).replace(/"/g, '\\"') + '"]';
    var parts = [];
    var node = element;
    for (var depth = 0; node && node.tagName && depth < 4; depth++) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift("#" + escapeSelector(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent && parent.children) {
        var same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  // Host context is useful only when it is safe to share. Never include a
  // credential, payment or private field in the element index, selection or
  // freeform page summary. Hosts can also opt an entire region out.
  function isSensitiveNode(element) {
    if (!element) return true;
    var type = compact(element.type || (element.getAttribute && element.getAttribute("type")), 80).toLowerCase();
    var autocomplete = compact(element.autocomplete || (element.getAttribute && element.getAttribute("autocomplete")), 120).toLowerCase();
    var identity = compact([
      element.name,
      element.id,
      element.getAttribute && element.getAttribute("name"),
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("placeholder"),
      element.getAttribute && element.getAttribute("data-jarvis-id"),
    ].join(" "), 500).toLowerCase();
    var hidden = element.hidden === true || type === "hidden" || (element.getAttribute && element.getAttribute("aria-hidden") === "true");
    return type === "password"
      || hidden
      || /(?:password|passcode|secret|token|api[ _-]?key|auth|otp|one[ _-]?time)/.test(autocomplete)
      || /(?:password|passcode|secret|token|api[ _-]?key|auth|otp|one[ _-]?time|credit[ _-]?card|card[ _-]?number|cvv|cvc|iban|payment|billing|bank[ _-]?account)/.test(identity);
  }

  function isSensitiveElement(element) {
    if (!element) return true;
    // The opt-out predicates are inherited by every action path, not just
    // context extraction. A safe-looking child of a payment/private region is
    // still not available for remote spotlight, activation or edit selection.
    if (element.closest && element.closest("[data-jarvis-private], [data-jarvis-no-context]")) return true;
    var node = element;
    for (var depth = 0; node && depth < 16; depth++) {
      if (isSensitiveNode(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function elementLabel(element) {
    if (!element || isSensitiveElement(element)) return "";
    var dataLabel = element.dataset && element.dataset.jarvisLabel;
    return compact(
      dataLabel
      || (element.getAttribute && (element.getAttribute("aria-label") || element.getAttribute("title")))
      || element.innerText
      || element.textContent
      || element.value
      || element.placeholder
      || element.id,
      220,
    );
  }

  function describeElement(element, index) {
    if (isSensitiveElement(element)) return null;
    var sourceOwner = element && element.closest ? element.closest("[data-jarvis-source]") : null;
    var role = element && element.getAttribute ? element.getAttribute("role") : "";
    if (!role && element && element.tagName) {
      role = /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ? element.tagName.toLowerCase() : "region";
    }
    return {
      id: compact((element && element.dataset && element.dataset.jarvisId) || (element && element.id) || (role + ":" + index), 180),
      label: elementLabel(element) || compact(role + " " + index, 80),
      role: compact(role, 80),
      source: compact(sourceOwner && sourceOwner.dataset && sourceOwner.dataset.jarvisSource, 500),
      selector: compact(stableSelector(element), 500),
    };
  }

  function contextElements() {
    if (!document.querySelectorAll) return [];
    var seen = {};
    var rows = [];
    var selectors = [
      "[data-jarvis-id^='widget:']",
      "[data-jarvis-id^='control:']",
      "[data-jarvis-id^='region:'],[data-jarvis-id^='navigation:'],[data-jarvis-id^='page:']",
      "[data-jarvis-id^='app:']",
      "[data-jarvis-id],[data-jarvis-editable]",
      "button,a[href],input,textarea,select,[role='button'],[role='link'],[role='region']",
    ];
    for (var group = 0; group < selectors.length && rows.length < 48; group++) {
      var nodes = document.querySelectorAll(selectors[group]);
      for (var i = 0; i < nodes.length && rows.length < 48; i++) {
        var node = nodes[i];
        if (node === f || isSensitiveElement(node) || (node.closest && node.closest("[data-jarvis-edit-ui]"))) continue;
        var row = describeElement(node, i);
        if (!row) continue;
        var key = row.id + "|" + row.label;
        if (!row.label || seen[key]) continue;
        seen[key] = true;
        rows.push(row);
      }
    }
    return rows;
  }

  function hostContext() {
    var selection = "";
    var text = "";
    var app = "";
    try {
      // A browser selection has no reliable field provenance across every
      // host (a selected token can look exactly like a heading). Keep it out
      // of the cross-origin contract; the safe element index below is the
      // bounded context contract for editable controls.
      var contextNodes = document.querySelectorAll ? document.querySelectorAll("[data-jarvis-context],main h1,main h2,main h3,main p,main [role='heading']") : [];
      var textParts = [];
      for (var i = 0; i < contextNodes.length && textParts.length < 24; i++) {
        var node = contextNodes[i];
        if (isSensitiveElement(node) || (node.closest && node.closest("[data-jarvis-edit-ui]"))) continue;
        var part = compact(node.innerText || node.textContent, 260);
        if (part) textParts.push(part);
      }
      text = compact(textParts.join(" · "), 2400);
      var appNode = document.querySelector ? document.querySelector("[data-jarvis-app]") : null;
      app = compact((appNode && appNode.dataset && appNode.dataset.jarvisApp) || configuredApp, 120);
    } catch {}
    var route = "";
    try {
      var parsed = new URL(location.href);
      route = parsed.pathname + parsed.search + parsed.hash;
    } catch {}
    return {
      hostId: HOST_ID,
      url: location.href,
      title: document.title || "",
      app: app,
      route: route,
      selection: selection,
      text: text,
      elements: contextElements(),
      editTarget: confirmedEditTarget,
    };
  }

  function postHostContext() {
    if (ready) post({ jarvis: "host-context", context: hostContext() });
  }

  function mount() {
    if (document.body) {
      var firstMount = !f.isConnected;
      if (firstMount) document.body.appendChild(f);
      if (!controls.isConnected) document.body.appendChild(controls);
      paintUniversalControls();
      if (firstMount) {
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
  }

  function wakeState(listening, reason) {
    f.dataset.jarvisWake = listening ? "listening" : reason || "idle";
    post({ jarvis: "host-wake-state", listening: Boolean(listening), reason: reason || null });
    try {
      window.dispatchEvent(new CustomEvent("jarvis:wake-state", {
        detail: { listening: Boolean(listening), reason: reason || null },
      }));
    } catch {}
    paintUniversalControls();
  }

  function show() {
    mount();
    visible = true;
    f.style.opacity = "1";
    f.style.transform = "translateY(0)";
    f.style.pointerEvents = "auto";
    post({ jarvis: "host-show" });
    postHostContext();
    if (navigator.userActivation && navigator.userActivation.isActive) enableWakeFromGesture();
    paintUniversalControls();
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
    paintUniversalControls();
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

  function notifyHostAction(action) {
    var detail = { action: action, handled: false, result: null };
    try {
      window.dispatchEvent(new CustomEvent("jarvis:host-action", { detail: detail }));
    } catch {}
    return detail;
  }

  function findHostElement(target, widgetOnly) {
    var wanted = normal(target);
    if (!wanted) return null;
    if (document.getElementById) {
      var exact = document.getElementById("w-" + target) || document.getElementById(target);
      if (exact && !isSensitiveElement(exact)) return exact;
    }
    if (!document.querySelectorAll) return null;
    var selector = widgetOnly
      ? "[id^='w-'],[data-jarvis-id*='widget']"
      : "[data-jarvis-id],[data-jarvis-editable],button,a[href],input,textarea,select,[role='button'],[role='link'],[role='region']";
    var nodes = document.querySelectorAll(selector);
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node === f || isSensitiveElement(node) || (node.closest && node.closest("[data-jarvis-edit-ui]"))) continue;
      var hay = normal(((node.dataset && node.dataset.jarvisId) || "") + " " + elementLabel(node) + " " + (node.id || ""));
      var score = hay === wanted ? 5 : hay.indexOf(wanted) >= 0 ? 3 : wanted.indexOf(hay) >= 0 && hay.length > 2 ? 2 : 0;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  function spotlight(element) {
    if (!element || isSensitiveElement(element)) return false;
    try { element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch {}
    if (!element.style) return;
    var outline = element.style.outline;
    var offset = element.style.outlineOffset;
    var shadow = element.style.boxShadow;
    element.style.outline = "2px solid #67e8f9";
    element.style.outlineOffset = "5px";
    element.style.boxShadow = "0 0 0 8px rgba(34,211,238,.12),0 0 42px rgba(34,211,238,.28)";
    setTimeout(function () {
      element.style.outline = outline;
      element.style.outlineOffset = offset;
      element.style.boxShadow = shadow;
    }, 2200);
    return true;
  }

  function editCandidate(target) {
    if (!target || target === f) return null;
    if (isSensitiveElement(target)) return null;
    if (target.closest && target.closest("[data-jarvis-edit-ui]")) return null;
    var candidate = target.closest
      ? target.closest("[data-jarvis-editable],[data-jarvis-source],button,a,input,textarea,select,[role],section,article,header,main")
      : target;
    return isSensitiveElement(candidate) ? null : candidate;
  }

  function clearEditMode() {
    if (!editSession) return;
    document.removeEventListener("pointermove", editSession.move, true);
    document.removeEventListener("click", editSession.click, true);
    document.removeEventListener("keydown", editSession.key, true);
    if (editSession.outline && editSession.outline.remove) editSession.outline.remove();
    if (editSession.card && editSession.card.remove) editSession.card.remove();
    editSession = null;
    paintUniversalControls();
  }

  function startEditMode(instruction) {
    if (!document.body || !document.createElement) return false;
    clearEditMode();
    var outline = document.createElement("div");
    outline.dataset.jarvisEditUi = "outline";
    outline.style.cssText = "position:fixed;display:none;pointer-events:none;z-index:2147483645;border:2px solid #67e8f9;border-radius:10px;background:rgba(34,211,238,.05);box-shadow:0 0 0 5px rgba(34,211,238,.11),0 0 38px rgba(34,211,238,.24);transition:left .08s,top .08s,width .08s,height .08s";
    var card = document.createElement("div");
    card.dataset.jarvisEditUi = "card";
    // Keep the selector instructions above the universal controls. At phone
    // widths the old 16px bottom edge put both fixed surfaces on top of each
    // other, obscuring the instructions and the cancel action.
    card.style.cssText = "position:fixed;left:16px;bottom:72px;z-index:2147483646;width:min(430px,calc(100vw - 32px));padding:14px 15px;border:1px solid rgba(103,232,249,.35);border-radius:16px;background:rgba(4,9,16,.96);box-shadow:0 20px 70px rgba(0,0,0,.5);color:#e7f8ff;font:500 13px/1.45 system-ui,sans-serif;backdrop-filter:blur(18px)";
    document.body.appendChild(outline);
    document.body.appendChild(card);
    var selected = null;

    function button(label, onClick, primary) {
      var node = document.createElement("button");
      node.type = "button";
      node.textContent = label;
      node.style.cssText = "border:1px solid " + (primary ? "rgba(103,232,249,.55)" : "rgba(255,255,255,.14)") + ";border-radius:9px;background:" + (primary ? "rgba(34,211,238,.14)" : "rgba(255,255,255,.04)") + ";color:" + (primary ? "#67e8f9" : "#b5c6ce") + ";padding:7px 10px;cursor:pointer;font:600 11px system-ui,sans-serif";
      node.onclick = onClick;
      return node;
    }

    function render(confirming) {
      while (card.firstChild) card.removeChild(card.firstChild);
      var eyebrow = document.createElement("div");
      eyebrow.textContent = confirming ? "CONFIRM EDIT TARGET" : "JARVIS VISUAL EDIT";
      eyebrow.style.cssText = "color:#67e8f9;font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;margin-bottom:7px";
      var title = document.createElement("div");
      title.textContent = selected ? elementLabel(selected) || "Selected element" : "Point at the exact element, click it, or tab to it and press Enter";
      title.style.cssText = "font-size:14px;font-weight:650;color:#f2fbff;margin-bottom:4px";
      var meta = document.createElement("div");
      var descriptor = selected ? describeElement(selected, 0) : null;
      meta.textContent = descriptor && descriptor.source
        ? descriptor.source
        : confirming ? "DOM selector will be linked to the engineering agent." : compact(instruction, 180) || "Jarvis will carry the selected element and its code location into the conversation.";
      meta.style.cssText = "color:#8fa8b3;font-size:11px;margin-bottom:11px;word-break:break-word";
      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:7px;justify-content:flex-end";
      actions.appendChild(button("Cancel", clearEditMode, false));
      if (confirming) {
        actions.appendChild(button("Pick another", function () { selected = null; render(false); }, false));
        actions.appendChild(button("Use this", function () {
          confirmedEditTarget = describeElement(selected, 0);
          outline.style.borderColor = "#6ee7b7";
          outline.style.boxShadow = "0 0 0 6px rgba(110,231,183,.14),0 0 42px rgba(110,231,183,.3)";
          card.style.borderColor = "rgba(110,231,183,.5)";
          eyebrow.textContent = "TARGET LINKED";
          title.textContent = confirmedEditTarget.label;
          meta.textContent = confirmedEditTarget.source || confirmedEditTarget.selector;
          actions.replaceChildren();
          actions.appendChild(button("Sent to Jarvis", function () {}, true));
          ask(compact(instruction, 1200) || "Help me edit the selected element.");
          show();
          setTimeout(function () {
            clearEditMode();
            setTimeout(function () { confirmedEditTarget = null; }, 12000);
          }, 1800);
        }, true));
      }
      card.appendChild(eyebrow);
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actions);
    }

    function paint(element) {
      if (!element || !element.getBoundingClientRect) return;
      var rect = element.getBoundingClientRect();
      outline.style.display = "block";
      outline.style.left = Math.max(0, rect.left - 4) + "px";
      outline.style.top = Math.max(0, rect.top - 4) + "px";
      outline.style.width = Math.max(0, rect.width + 8) + "px";
      outline.style.height = Math.max(0, rect.height + 8) + "px";
    }

    var move = function (event) {
      if (selected) return;
      var candidate = editCandidate(event.target);
      if (candidate) paint(candidate);
    };
    var selectCandidate = function (candidate, event) {
      if (!candidate) return;
      if (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      }
      selected = candidate;
      paint(selected);
      render(true);
    };
    var click = function (event) {
      if (event.target && event.target.closest && event.target.closest("[data-jarvis-edit-ui]")) return;
      var candidate = editCandidate(event.target);
      selectCandidate(candidate, event);
    };
    var key = function (event) {
      if (event.key === "Escape") clearEditMode();
      if ((event.key === "Enter" || event.key === " ") && !selected) {
        var target = document.activeElement;
        if (target && !(target.closest && target.closest("[data-jarvis-edit-ui]"))) selectCandidate(editCandidate(target), event);
      }
    };
    editSession = { outline: outline, card: card, move: move, click: click, key: key };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    render(false);
    paintUniversalControls();
    return true;
  }

  function executeHostAction(action) {
    action = action || {};
    if (action.hostId && action.hostId !== HOST_ID) {
      return Promise.resolve({ ok: false, detail: "That command belongs to another Jarvis host." });
    }
    if (action.expectedUrl) {
      try {
        var expected = new URL(action.expectedUrl);
        var current = new URL(location.href);
        if (expected.origin !== current.origin || expected.pathname !== current.pathname) {
          return Promise.resolve({ ok: false, detail: "That command belongs to a different page." });
        }
      } catch {
        return Promise.resolve({ ok: false, detail: "The page guard was invalid." });
      }
    }
    if (action.action === "edit") {
      return Promise.resolve(startEditMode(action.instruction || "")
        ? { ok: true, detail: "Pick the exact element; I’ll link it to its code." }
        : { ok: false, detail: "Visual edit mode could not start on this page." });
    }
    if (action.action === "open_app") {
      try {
        var appUrl = new URL(action.url);
        if (appUrl.protocol !== "https:") throw new Error("unsafe URL");
        return Promise.resolve({ ok: true, detail: "Opening " + compact(action.target || appUrl.hostname, 100) + ".", navigateUrl: appUrl.href });
      } catch {
        return Promise.resolve({ ok: false, detail: "That app URL was rejected." });
      }
    }
    if (action.action === "navigate") {
      try {
        var nextUrl = new URL(action.target, location.href);
        if (nextUrl.origin !== location.origin) throw new Error("cross-origin route");
        return Promise.resolve({ ok: true, detail: "Opening " + compact(action.target, 100) + ".", navigateUrl: nextUrl.href });
      } catch {
        return Promise.resolve({ ok: false, detail: "Only a route inside this app can be opened here." });
      }
    }
    var element = findHostElement(action.target, action.action === "show_widget");
    if (!element || isSensitiveElement(element)) return Promise.resolve({ ok: false, detail: "I cannot act on that private control." });
    var custom = notifyHostAction(action);
    if (custom.handled) return Promise.resolve(custom.result || { ok: true, detail: "Done on this page." });
    spotlight(element);
    if (action.action === "activate") {
      setTimeout(function () { try { element.click(); } catch {} }, 120);
      return Promise.resolve({ ok: true, detail: "Opening " + (elementLabel(element) || compact(action.target, 100)) + "." });
    }
    return Promise.resolve({ ok: true, detail: "Showing " + (elementLabel(element) || compact(action.target, 100)) + "." });
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

  function isAmbientAcknowledgement(text) {
    return /^(?:thank you|thanks|thank you very much|thanks very much|cheers)[.!?]*$/i.test(String(text || "").trim());
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
        // Follow-ups have no wake-word proof. Never turn an interim browser
        // hypothesis into a command, and close the ambient window on bare
        // acknowledgements—the most common Chrome silence hallucination.
        if (!result.isFinal) continue;
        if (isAmbientAcknowledgement(text)) {
          pendingTranscript = "";
          commandModeUntil = 0;
          if (commandTimer) clearTimeout(commandTimer);
          commandTimer = null;
          continue;
        }
        stageTranscript(text, true);
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
    interrupt: function () {
      post({ jarvis: "host-interrupt" });
    },
    edit: function (instruction) {
      show();
      return startEditMode(String(instruction || ""));
    },
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
      postHostContext();
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
    } else if (data.jarvis === "host-action" && data.action && typeof data.action === "object") {
      executeHostAction(data.action).then(function (result) {
        result = result || { ok: false, detail: "The host action returned no result." };
        post({
          jarvis: "host-action-result",
          id: String(data.action.id || ""),
          ok: result.ok === true,
          detail: compact(result.detail, 500),
        });
        if (result.ok) setTimeout(postHostContext, 260);
        if (result.ok && result.navigateUrl) {
          setTimeout(function () { location.assign(result.navigateUrl); }, 620);
        }
      }).catch(function () {
        post({
          jarvis: "host-action-result",
          id: String(data.action.id || ""),
          ok: false,
          detail: "The host page could not complete that action.",
        });
      });
    } else if (data.jarvis === "context-request" && typeof data.id === "string") {
      post({
        jarvis: "context-response",
        id: data.id,
        context: hostContext(),
      });
    }
  });

  // Next.js and other client routers do not reload the embed, so keep the
  // iframe's view of the page current whenever the host route changes.
  ["pushState", "replaceState"].forEach(function (method) {
    if (!history || typeof history[method] !== "function") return;
    var original = history[method];
    history[method] = function () {
      var result = original.apply(this, arguments);
      setTimeout(postHostContext, 0);
      return result;
    };
  });
  window.addEventListener("popstate", postHostContext);
  window.addEventListener("hashchange", postHostContext);
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || editSession || !visible) return;
    post({ jarvis: "host-interrupt" });
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
