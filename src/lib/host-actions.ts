export type JarvisHostActionName =
  | "open_app"
  | "show_widget"
  | "focus"
  | "activate"
  | "navigate"
  | "edit";

export type JarvisHostAction = {
  id?: string;
  hostId?: string;
  action: JarvisHostActionName;
  target?: string;
  url?: string;
  instruction?: string;
  expectedUrl?: string;
};

export type HostApp = { name: string; url: string; aliases: string[] };

export const HOST_APPS: HostApp[] = [
  { name: "Rental Manager", url: "https://rental-manager-v2-nu.vercel.app", aliases: ["rental manager", "rentals app", "rmv2", "rental-manager", "hygglo dashboard"] },
  { name: "Project Hub", url: "https://project-hub-olive-pi.vercel.app", aliases: ["project hub", "the hub", "project-hub"] },
  { name: "Music House", url: "https://music-house-nine.vercel.app", aliases: ["music house", "music-house", "music app"] },
  { name: "YouTube Studio AI", url: "https://youtube-studio-ai.vercel.app", aliases: ["youtube studio ai", "youtube studio", "my youtube studio", "ysa", "youtube app", "video factory"] },
  { name: "Remote Work Hub", url: "https://remote-work-hub-sepia.vercel.app", aliases: ["remote work hub", "rwh", "work hub", "agents hub"] },
  { name: "Media Engine", url: "https://media-engine-seven.vercel.app", aliases: ["media engine", "media-engine"] },
  { name: "App Factory", url: "https://app-factory-v2.vercel.app", aliases: ["app factory", "factory", "app-factory"] },
  { name: "Finance Engine", url: "https://finance-engine-v2-cyan.vercel.app", aliases: ["finance engine", "finance app", "crypto lab"] },
  { name: "DB Cinema", url: "https://dbcinemarentals.com", aliases: ["db cinema", "cinema rentals", "rental storefront"] },
  { name: "JARVIS", url: "https://jarvis-orcin-six.vercel.app", aliases: ["jarvis app", "your app", "your ui"] },
];

const WIDGET_ALIASES: Array<{ type: string; label: string; aliases: string[] }> = [
  { type: "notes", label: "Notes", aliases: ["notes", "note"] },
  { type: "calendar", label: "Calendar", aliases: ["calendar", "schedule"] },
  { type: "todo", label: "To-do", aliases: ["todo", "to do", "tasks", "task list"] },
  { type: "wealth", label: "Wealth", aliases: ["wealth", "net worth", "finances"] },
  { type: "projects", label: "Projects", aliases: ["projects", "portfolio", "apps"] },
  { type: "expenses", label: "Expenses", aliases: ["expenses", "costs"] },
  { type: "hunts", label: "Hunts and alerts", aliases: ["hunts", "alerts", "price alerts"] },
  { type: "idea", label: "Ideas", aliases: ["ideas", "daily idea"] },
  { type: "channelIdea", label: "Channel ideas", aliases: ["channel ideas", "youtube ideas"] },
  { type: "remoteWorkHub", label: "Remote work", aliases: ["remote work", "workers", "agents"] },
  { type: "travel", label: "Travel", aliases: ["travel", "trips", "trip planner"] },
  { type: "music", label: "Music", aliases: ["music", "songs"] },
];

const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findHostApp(value: string): HostApp | undefined {
  const wanted = normal(value);
  if (!wanted) return undefined;
  return HOST_APPS.find((app) =>
    [app.name, ...app.aliases].some((alias) => {
      const candidate = normal(alias);
      return wanted.includes(candidate) || candidate.includes(wanted);
    }),
  );
}

export function parseEmbeddedHostIntent(text: string): { action: JarvisHostAction; reply: string } | null {
  const raw = text.trim();
  const value = normal(raw);
  if (!value || raw.split(/\s+/).length > 16 || /\b(?:and then|then also|and also)\b/i.test(raw)) return null;

  if (
    /\b(?:visual\s+)?edit(?:ing)?\s+mode\b/i.test(raw)
    || /\b(?:edit|fix|change|modify|redesign)\b.{0,48}\b(?:this|current)\b.{0,24}\b(?:page|screen|app|widget|section)\b/i.test(raw)
  ) {
    return {
      action: { action: "edit", instruction: raw },
      reply: "Pick the exact element; I’ll link it to its code.",
    };
  }

  if (/\b(?:open|launch|pull up|go to|take me to)\b/i.test(raw)) {
    const app = findHostApp(value.replace(/\b(?:open|launch|pull up|go to|take me to|my|the)\b/g, " "));
    if (app) {
      return {
        action: { action: "open_app", target: app.name, url: app.url },
        reply: `Opening ${app.name}.`,
      };
    }
  }

  if (/\b(?:show|open|pull up|take me to|focus|highlight)\b/i.test(raw)) {
    const widget = WIDGET_ALIASES.find((entry) => entry.aliases.some((alias) => value.includes(normal(alias))));
    if (widget && (value.includes("widget") || /\b(?:show|focus|highlight|take me to)\b/i.test(raw))) {
      return {
        action: { action: "show_widget", target: widget.type },
        reply: `Showing ${widget.label}.`,
      };
    }
    const control = ["settings", "notifications", "apps", "search"].find((label) => value.includes(label));
    if (control) {
      return {
        action: { action: "activate", target: control },
        reply: `Opening ${control}.`,
      };
    }
  }
  return null;
}
