// JARVIS everywhere — one script tag on any of Daniel's internal apps:
//   <script src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js" defer></script>
// The canonical client stays loaded (and listening for "hey jarvis") while its
// frame is invisible, then opens without remounting or swapping implementations.
// by the wake word, or programmatically via window.JARVIS.toggle() from a
// header button. It never floats over the page uninvited.
(function () {
  if (window.__jarvisEmbed) return;
  window.__jarvisEmbed = 1;
  var ORIGIN = "https://jarvis-orcin-six.vercel.app";
  if (location.origin === ORIGIN) return; // never embed JARVIS inside JARVIS

  var visible = false;
  var ready = false;
  var pendingCommands = [];
  var f = document.createElement("iframe");
  // Version the document as well as this loader. Long-lived Hub tabs used to
  // preserve an obsolete full-chat frame across Jarvis deployments.
  f.src = ORIGIN + "/embed?v=hub-orb-voice-20260718-1";
  f.title = "JARVIS";
  f.allow = "microphone; autoplay; clipboard-write; display-capture";
  f.style.cssText =
    "position:fixed;bottom:8px;right:8px;width:min(460px,calc(100vw - 16px));height:min(520px,calc(100vh - 16px));border:0;" +
    "border-radius:28px;z-index:2147483000;background:#05070d;color-scheme:dark;" +
    "box-shadow:none;transition:opacity .2s ease,transform .28s cubic-bezier(.22,1,.36,1);" +
    "opacity:0;transform:translateY(14px);pointer-events:none;";

  function show() {
    visible = true;
    f.style.opacity = "1";
    f.style.transform = "translateY(0)";
    f.style.pointerEvents = "auto";
    if (f.contentWindow) f.contentWindow.postMessage({ jarvis: "host-show" }, ORIGIN);
  }
  function hide() {
    visible = false;
    f.style.opacity = "0";
    f.style.transform = "translateY(14px)";
    f.style.pointerEvents = "none";
    if (f.contentWindow) f.contentWindow.postMessage({ jarvis: "host-hide" }, ORIGIN);
  }
  function flushCommands() {
    if (!ready || !f.contentWindow) return;
    while (pendingCommands.length) {
      f.contentWindow.postMessage({ jarvis: "host-command", text: pendingCommands.shift() }, ORIGIN);
    }
  }
  function ask(text) {
    var command = String(text || "").trim().slice(0, 4000);
    if (!command) return;
    pendingCommands.push(command);
    show();
    flushCommands();
  }
  window.JARVIS = {
    show: show,
    hide: hide,
    ask: ask,
    toggle: function () {
      if (visible) hide();
      else show();
    },
    get visible() {
      return visible;
    },
  };

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || e.source !== f.contentWindow) return;
    var d = e.data || {};
    if (d.jarvis === "ready") {
      ready = true;
      flushCommands();
    } else if (d.jarvis === "wake" || d.jarvis === "notify") show();
    else if (d.jarvis === "hide") hide();
    else if (d.jarvis === "context-request" && typeof d.id === "string") {
      var selection = "";
      var text = "";
      try {
        selection = String(window.getSelection ? window.getSelection() : "").slice(0, 1800);
        text = String(document.body ? document.body.innerText : "").slice(0, 7000);
      } catch (_) {}
      f.contentWindow.postMessage(
        {
          jarvis: "context-response",
          id: d.id,
          context: { url: location.href, title: document.title, selection: selection, text: text },
        },
        ORIGIN,
      );
    }
  });

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
      } catch (_) {}
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
