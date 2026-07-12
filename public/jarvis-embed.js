// JARVIS everywhere — drop this one script tag on any of Daniel's internal
// apps and the mini-orb appears bottom-right (mic + wake word enabled):
//   <script src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js" defer></script>
(function () {
  if (window.__jarvisEmbed) return;
  window.__jarvisEmbed = 1;
  var ORIGIN = "https://jarvis-orcin-six.vercel.app";
  // Don't embed JARVIS inside JARVIS.
  if (location.origin === ORIGIN) return;

  var f = document.createElement("iframe");
  f.src = ORIGIN + "/embed";
  f.title = "JARVIS";
  f.allow = "microphone; autoplay; clipboard-write";
  f.style.cssText =
    "position:fixed;bottom:14px;right:14px;width:340px;height:72px;max-width:94vw;border:0;" +
    "border-radius:20px;z-index:2147483000;background:transparent;color-scheme:dark;" +
    "box-shadow:0 14px 44px rgba(0,0,0,.55);transition:height .25s ease;";

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data || {};
    if (d.jarvis === "size" && typeof d.h === "number") {
      f.style.height = Math.max(64, Math.min(d.h, window.innerHeight - 40)) + "px";
    }
  });

  function mount() {
    if (!f.isConnected && document.body) document.body.appendChild(f);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
