// JARVIS everywhere — one script tag on any of Daniel's internal apps:
//   <script src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js" defer></script>
// The widget stays INVISIBLE (but listening for "hey jarvis") until summoned —
// by the wake word, or programmatically via window.JARVIS.toggle() from a
// header button. It never floats over the page uninvited.
(function () {
  if (window.__jarvisEmbed) return;
  window.__jarvisEmbed = 1;
  var ORIGIN = "https://jarvis-orcin-six.vercel.app";
  if (location.origin === ORIGIN) return; // never embed JARVIS inside JARVIS

  var visible = false;
  var f = document.createElement("iframe");
  f.src = ORIGIN + "/embed";
  f.title = "JARVIS";
  f.allow = "microphone; autoplay; clipboard-write";
  f.style.cssText =
    "position:fixed;bottom:14px;right:14px;width:340px;height:72px;max-width:94vw;border:0;" +
    "border-radius:20px;z-index:2147483000;background:transparent;color-scheme:dark;" +
    "box-shadow:0 14px 44px rgba(0,0,0,.55);transition:height .25s ease,opacity .3s ease,transform .3s ease;" +
    "opacity:0;transform:translateY(14px);pointer-events:none;";

  function show() {
    visible = true;
    f.style.opacity = "1";
    f.style.transform = "translateY(0)";
    f.style.pointerEvents = "auto";
  }
  function hide() {
    visible = false;
    f.style.opacity = "0";
    f.style.transform = "translateY(14px)";
    f.style.pointerEvents = "none";
  }
  window.JARVIS = {
    show: show,
    hide: hide,
    toggle: function () {
      if (visible) hide();
      else show();
    },
    get visible() {
      return visible;
    },
  };

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data || {};
    if (d.jarvis === "size" && typeof d.h === "number") {
      f.style.height = Math.max(64, Math.min(d.h, window.innerHeight - 40)) + "px";
    } else if (d.jarvis === "wake") show(); // "hey jarvis" → the widget appears
    else if (d.jarvis === "hide") hide();
  });

  function mount() {
    if (!f.isConnected && document.body) document.body.appendChild(f);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
