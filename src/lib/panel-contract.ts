export type PanelInput = { type: string; value: string };

export type PanelRenderer =
  | "site"
  | "widget"
  | "canvas"
  | "trip"
  | "doc"
  | "launch"
  | "pdf"
  | "creations"
  | "fleet"
  | "board"
  | "scene"
  | "iframe"
  | "image"
  | "code"
  | "list"
  | "markdown";

export type PanelRoute = {
  renderer: PanelRenderer;
  semanticKind: string;
  size: string;
  keepOrbVisible: boolean;
};

function widgetKind(value: string): string {
  try {
    return String(JSON.parse(value)?.kind ?? "generic");
  } catch {
    return "generic";
  }
}

export function resolvePanelRoute(panel: PanelInput): PanelRoute {
  const widget = panel.type === "widget" ? widgetKind(panel.value) : null;
  const semanticKind = widget ? `widget:${widget}` : panel.type;
  const renderer: PanelRenderer =
    panel.type === "site" ? "site"
      : panel.type === "widget" ? "widget"
        : panel.type === "canvas" ? "canvas"
          : panel.type === "trip" ? "trip"
            : panel.type === "doc" ? "doc"
              : panel.type === "launch" ? "launch"
                : panel.type === "pdf" ? "pdf"
                  : panel.type === "creations" ? "creations"
                    : panel.type === "fleet" ? "fleet"
                      : panel.type === "board" ? "board"
                        : panel.type === "scene" ? "scene"
                          : panel.type === "url" || panel.type === "video" ? "iframe"
                            : panel.type === "image" ? "image"
                              : panel.type === "code" ? "code"
                                : panel.type === "list" ? "list"
                                  : "markdown";

  let size = "h-full w-full";
  switch (semanticKind) {
    case "launch": size = "w-[min(560px,94%)] h-[400px]"; break;
    case "widget:timer": size = "w-[min(500px,94%)] h-[460px]"; break;
    case "widget:mac_action": size = "w-[min(620px,94%)] h-[480px]"; break;
    case "widget:mac_setup": size = "w-[min(720px,96%)] h-[min(680px,92%)]"; break;
    case "widget:weather": size = "w-[min(880px,80%)] h-[min(640px,90%)]"; break;
    case "widget:market": size = "w-[96%] md:w-[min(880px,calc(100%-250px))] h-[min(540px,86%)]"; break;
    case "image": size = "w-[min(1100px,97%)] h-[min(760px,97%)]"; break;
    case "widget:candles":
    case "widget:chart_loading": size = "w-[96%] md:w-[min(1040px,calc(100%-250px))] h-[min(680px,88%)]"; break;
    case "widget:briefing":
    case "widget:briefing2": size = "w-[96%] md:w-[min(980px,calc(100%-250px))] h-[min(700px,90%)]"; break;
    case "widget:calendar":
    case "widget:todos": size = "w-[96%] md:w-[min(900px,calc(100%-250px))] h-[min(680px,88%)]"; break;
    case "widget:net_worth_loading":
    case "widget:stats": size = "w-[96%] h-[min(680px,92%)]"; break;
    case "widget:videos":
    case "widget:feed": size = "w-[min(1340px,82%)] h-[min(740px,92%)]"; break;
    case "widget:shop": size = "w-[min(1340px,82%)] h-[min(700px,92%)]"; break;
    case "widget:webresults": size = "w-[min(1340px,84%)] h-[min(720px,92%)]"; break;
    case "widget:places": size = "w-[min(1200px,90%)] h-[min(760px,94%)]"; break;
    case "widget:ranking": size = "w-[min(1180px,88%)] h-[min(780px,94%)]"; break;
    case "widget:calc": size = "w-[min(560px,94%)] h-[min(360px,80%)]"; break;
    case "scene": size = "w-[min(1440px,98%)] h-[min(820px,97%)]"; break;
    case "board":
    case "canvas": size = "w-[97%] md:w-full h-[min(820px,96%)]"; break;
    case "markdown": size = "w-[min(980px,97%)] h-full"; break;
    case "list": size = "w-[96%] md:w-[min(920px,calc(100%-250px))] h-[min(720px,92%)]"; break;
    case "doc": size = "w-[min(880px,80%)] h-[min(800px,94%)]"; break;
    case "creations": size = "w-[96%] md:w-full md:max-w-[1200px] h-[min(780px,94%)]"; break;
    case "trip": size = "w-[97%] md:w-full h-[min(820px,96%)]"; break;
    case "fleet": size = "w-[96%] md:w-full md:max-w-[1120px] h-[min(760px,92%)]"; break;
    case "pdf": size = "w-[96%] md:w-full md:max-w-[1020px] h-[min(800px,94%)]"; break;
    case "site":
    case "url": size = "w-[97%] md:w-full h-[min(800px,94%)]"; break;
    case "code": size = "w-[96%] md:w-full md:max-w-[980px] h-[min(760px,92%)]"; break;
  }
  // Unknown future panel types intentionally use the markdown renderer. Give
  // that safe fallback the same side-stage geometry instead of hiding Jarvis.
  if (size === "h-full w-full" && renderer === "markdown") size = "w-[min(980px,97%)] h-[min(760px,94%)]";
  return { renderer, semanticKind, size, keepOrbVisible: size !== "h-full w-full" && panel.type !== "video" };
}
