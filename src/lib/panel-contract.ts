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
  | "travel"
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
  presentation: "compact" | "wide" | "workspace";
  size: string;
  keepOrbVisible: boolean;
};

export type JarvisEmbedLayoutMode = "compact" | "chat" | "workspace";

export function resolveEmbedLayoutMode(args: {
  expanded: boolean;
  panelVisible: boolean;
  panelFull: boolean;
  presentation?: PanelRoute["presentation"];
}): JarvisEmbedLayoutMode {
  if (!args.expanded) return "compact";
  if (args.panelFull || (args.panelVisible && args.presentation !== "compact")) return "workspace";
  return "chat";
}

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
                    : panel.type === "travel" ? "travel"
                      : panel.type === "fleet" ? "fleet"
                        : panel.type === "board" ? "board"
                          : panel.type === "scene" ? "scene"
                            : panel.type === "url" || panel.type === "video" ? "iframe"
                              : panel.type === "image" ? "image"
                                : panel.type === "code" ? "code"
                                  : panel.type === "list" ? "list"
                                    : "markdown";

  let presentation: PanelRoute["presentation"] = "wide";
  let size = "h-[min(760px,96%)] w-[min(980px,98%)]";
  switch (semanticKind) {
    case "launch": presentation = "compact"; size = "h-[400px] w-[min(560px,96%)]"; break;
    case "widget:timer": presentation = "compact"; size = "h-[min(460px,92%)] w-[min(500px,96%)]"; break;
    case "widget:mac_action": presentation = "compact"; size = "h-[min(480px,92%)] w-[min(620px,96%)]"; break;
    case "widget:mac_setup": presentation = "compact"; size = "h-[min(680px,94%)] w-[min(720px,97%)]"; break;
    case "widget:weather": presentation = "compact"; size = "h-[min(640px,94%)] w-[min(880px,98%)]"; break;
    case "widget:market": size = "h-[min(560px,92%)] w-[min(920px,98%)]"; break;
    case "image": size = "h-[min(800px,98%)] w-[min(1200px,99%)]"; break;
    case "widget:candles":
    case "widget:chart_loading": size = "h-[min(700px,96%)] w-[min(1100px,99%)]"; break;
    case "widget:briefing":
    case "widget:briefing2": size = "h-[min(720px,96%)] w-[min(1040px,99%)]"; break;
    case "widget:calendar":
    case "widget:bookings":
    case "widget:todos": size = "h-[min(720px,96%)] w-[min(1040px,99%)]"; break;
    case "widget:net_worth_loading":
    case "widget:stats": size = "h-[min(700px,96%)] w-[min(1080px,99%)]"; break;
    case "widget:videos":
    case "widget:feed": size = "h-[min(760px,97%)] w-[min(1340px,99%)]"; break;
    case "widget:shop": size = "h-[min(740px,97%)] w-[min(1340px,99%)]"; break;
    case "widget:webresults": size = "h-[min(760px,97%)] w-[min(1340px,99%)]"; break;
    case "widget:places": size = "h-[min(800px,98%)] w-[min(1260px,99%)]"; break;
    case "widget:ranking": size = "h-[min(800px,98%)] w-[min(1220px,99%)]"; break;
    case "widget:calc": presentation = "compact"; size = "h-[min(360px,80%)] w-[min(560px,96%)]"; break;
    case "scene": presentation = "workspace"; size = "h-full w-full"; break;
    case "board":
    case "canvas": presentation = "workspace"; size = "h-full w-full"; break;
    case "markdown": size = "h-[min(780px,98%)] w-[min(1040px,99%)]"; break;
    case "list": size = "h-[min(760px,97%)] w-[min(1040px,99%)]"; break;
    case "doc": size = "h-[min(820px,98%)] w-[min(940px,99%)]"; break;
    case "creations": presentation = "workspace"; size = "h-full w-full"; break;
    case "travel": presentation = "workspace"; size = "h-full w-full"; break;
    case "trip": presentation = "workspace"; size = "h-full w-full"; break;
    case "fleet": presentation = "workspace"; size = "h-full w-full"; break;
    case "pdf": presentation = "workspace"; size = "h-full w-full"; break;
    case "site":
    case "url": presentation = "workspace"; size = "h-full w-full"; break;
    case "video": presentation = "workspace"; size = "h-full w-full"; break;
    case "code": size = "h-[min(800px,98%)] w-[min(1040px,99%)]"; break;
  }
  return {
    renderer,
    semanticKind,
    presentation,
    size,
    keepOrbVisible: presentation === "compact" && panel.type !== "video",
  };
}
