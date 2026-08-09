export type ContextProfile = "reflex" | "focused" | "operational" | "strategic";

type ContextRow = Record<string, unknown>;

type BrainContext = {
  currentState?: ContextRow[];
  memory?: ContextRow[];
  projects?: ContextRow[];
  goals?: ContextRow[];
  goalMissions?: ContextRow[];
  attention?: ContextRow[];
  approvals?: ContextRow[];
  jobs?: ContextRow[];
  agents?: ContextRow[];
  business?: ContextRow[];
  creations?: ContextRow[];
  findings?: ContextRow[];
  trip?: ContextRow | null;
  draft?: ContextRow | null;
  location?: ContextRow | null;
  panel?: ContextRow | null;
};

type HubContext = {
  todos?: ContextRow[];
  events?: ContextRow[];
  wealth?: ContextRow | null;
};

export type ContextCompilerInput = {
  userText?: string;
  northStar: string;
  brain: BrainContext | null;
  hub: HubContext | null;
  projectRegistry: readonly { slug: string; name: string; vision: string }[];
};

export const CONTEXT_COMPILER_MAX_CHARS = 6_200;

const REFLEX = /^(?:hi|hey|hello|yo|thanks|thank you|ok(?:ay)?|sup|morning|evening|good (?:morning|evening|day)|what'?s up|how are you)[!.?\s]*$/i;
const STRATEGIC = /\b(?:architecture|strategy|portfolio|roadmap|trade-?offs?|compare|decision|design|multi[- ]?(?:repo|project)|root cause|production outage|from first principles|deep dive)\b/i;
const FOCUSED = /\b(?:weather|time|calendar|schedule|todo|remind|price|price of|play|pause|open|show|where|when|who|what is|what's)\b/i;
const PLANNING = /\b(?:plan|build|create|fix|investigate|research|analyse|analyze|recommend|implement|ship|delegate|agent|mission|goal|project)\b/i;
const MONEY = /\b(?:money|wealth|finance|crypto|stock|price|rental|revenue|budget|cost)\b/i;
const TIME = /\b(?:calendar|schedule|today|tomorrow|week|appointment|remind|todo|to-do)\b/i;
const ARTIFACT = /\b(?:draft|document|board|image|video|chart|scene|mind map|canvas|that one|this one|update it|rework)\b/i;
const FOLLOW_UP = /\b(?:this|that|it|there|second|third|previous|above|on screen|shown)\b/i;
const TRAVEL = /\b(?:trip|travel|flight|hotel|stay|airport|transfer|destination|itinerary)\b/i;
const DRAFT_EDIT = /\b(?:draft|document|write|writing|rewrite|edit|longer|shorter|warmer|tone|wording)\b/i;
const LOCATION = /\b(?:near me|nearby|local|location|directions?|routes?|maps?|places?|attractions?|city|restaurant|weather)\b/i;
const TEAM = /\b(?:agent|team|delegate|mission|goal|working|progress|status)\b/i;

const text = (value: unknown, max: number) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const asRow = (value: unknown): ContextRow =>
  value !== null && typeof value === "object" ? value as ContextRow : {};

const rowLine = (row: ContextRow, max = 520) => {
  const source = row?.source ? ` · ${text(row.source, 24)}` : "";
  const confidence = typeof row?.confidence === "number"
    ? ` · ${Math.round(Math.max(0, Math.min(1, row.confidence)) * 100)}%`
    : "";
  return `- ${text(row?.title, 110)} [${text(row?.kind, 24)}${source}${confidence}]: ${text(row?.body, max)}`;
};

export function classifyContextProfile(userText?: string): ContextProfile {
  const value = text(userText, 900);
  if (!value || REFLEX.test(value)) return "reflex";
  if (STRATEGIC.test(value)) return "strategic";
  if (FOCUSED.test(value) && !PLANNING.test(value)) return "focused";
  return "operational";
}

function projectMatches(project: unknown, userText: string) {
  const row = asRow(project);
  const data = asRow(row.data);
  const haystack = `${row.slug ?? ""} ${row.name ?? ""} ${row.summary ?? ""} ${data.purpose ?? ""}`.toLowerCase();
  const terms = userText.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 4);
  return terms.some((term) => haystack.includes(term));
}

function panelSummary(value: unknown) {
  const panel = asRow(value);
  if (!panel.type) return "";
  let title = text(panel.title, 160) || text(panel.type, 80);
  if (panel.type === "widget") {
    try {
      const widget = asRow(JSON.parse(String(panel.value)));
      title = text(widget.title ?? widget.kind, 160) || title;
      if (widget.kind === "ranking" && Array.isArray(widget.items)) {
        const items = widget.items
          .slice(0, 10)
          .map((item) => asRow(item))
          .map((item) => `#${text(item.rank, 8)} ${text(item.name, 90)}`)
          .filter((item) => item.trim().length > 2)
          .join(", ");
        if (items) {
          return `ON SCREEN: ranking “${title}” — ${items}. Resolve number/name follow-ups against this list and keep the current overlay.`;
        }
      }
    } catch {
      // The panel description is supplemental context. A malformed old panel
      // must never hold a foreground answer hostage.
    }
  }
  return `ON SCREEN: ${title} (${text(panel.type, 40)}). If the request refers to it, continue the same artifact rather than rebuilding it.`;
}

/**
 * Turns the broad durable brain snapshot into a small task-specific evidence
 * pack. This is deliberately deterministic: the foreground lane should not
 * spend a second model call deciding which context to send to the model.
 */
export function compileContext(input: ContextCompilerInput): string {
  const userText = text(input.userText, 900);
  const profile = classifyContextProfile(userText);
  const brain: BrainContext = input.brain ?? {};
  const hub: HubContext = input.hub ?? {};
  const lines: string[] = [];
  let used = 0;

  const add = (section: string, value: string, priority = false) => {
    const body = text(value, priority ? 1_600 : 1_100);
    if (!body || used >= CONTEXT_COMPILER_MAX_CHARS) return;
    const block = `${section}:\n${body}`;
    const remaining = CONTEXT_COMPILER_MAX_CHARS - used;
    lines.push(block.slice(0, remaining));
    used += Math.min(block.length, remaining) + 2;
  };

  add(
    "OPERATING PRINCIPLE",
    `Portfolio north star: ${text(input.northStar, 420)} Judge progress by verified movement toward intended outcomes, never by elapsed time alone.`,
    true,
  );
  add(
    "TURN MODE",
    profile === "reflex"
      ? "Respond immediately and naturally. Do not load work, narrate internal state, or create a plan unless Daniel asks."
      : profile === "focused"
        ? "Answer first. Use only the evidence and tool needed for this narrow request; put detail on screen instead of narrating it."
        : profile === "strategic"
          ? "State the recommendation first, then the decisive evidence. Escalate to one deliberate cross-check only for material uncertainty, irreversible consequences, or conflicting evidence; do not create a fleet merely to think aloud."
          : "Give the next useful action first. Keep work bounded, preserve approvals, and hand off durable multi-step execution rather than blocking the conversation.",
    true,
  );

  // Follow-up grounding belongs before broad memory/work state so a near-full
  // budget can never evict the thing Daniel is visibly referring to.
  if (ARTIFACT.test(userText) || FOLLOW_UP.test(userText)) {
    const panel = panelSummary(brain.panel);
    if (panel) add("DISPLAY CONTEXT", panel, true);
  }

  const memories = Array.isArray(brain.memory) ? brain.memory : [];
  const memoryLimit = profile === "reflex" ? 1 : profile === "focused" ? 3 : profile === "strategic" ? 8 : 5;
  if (memories.length && memoryLimit) {
    add(
      "RELEVANT MEMORY",
      memories.slice(0, memoryLimit).map((row) => rowLine(row, profile === "strategic" ? 480 : 300)).join("\n"),
    );
  }

  const currentState = Array.isArray(brain.currentState) ? brain.currentState : [];
  const currentLocation = currentState.find((row) => row.key === "profile.current_location");
  if (currentLocation?.value && (LOCATION.test(userText) || TRAVEL.test(userText) || FOLLOW_UP.test(userText))) {
    add(
      "CURRENT SITUATION",
      `Daniel's current location is ${text(currentLocation.value, 120)} (observed ${new Date(Number(currentLocation.observedAt ?? 0)).toISOString()}). Use it as the default map, weather, route, and nearby-search origin until superseded.`,
      true,
    );
  }

  const projects = Array.isArray(brain.projects) ? brain.projects : [];
  const relevantProjects = projects.filter((project) => projectMatches(project, userText));
  const projectNeed = profile === "strategic" || /\b(?:project|portfolio|app|business)\b/i.test(userText);
  const selectedProjects = relevantProjects.length
    ? relevantProjects.slice(0, profile === "strategic" ? 6 : 3)
    : projectNeed
      ? projects.slice(0, profile === "strategic" ? 5 : 2)
      : [];
  if (selectedProjects.length) {
    add(
      "PORTFOLIO STATE CARDS",
      selectedProjects.map((project) => {
        const data = asRow(project.data);
        return `- ${text(project.slug, 70)} [${text(project.status, 40)}]: ${text(data.purpose ?? project.summary, 240)}` +
          `${data.vision ? ` Vision: ${text(data.vision, 180)}` : ""}` +
          `${data.recent ? ` Latest verified change: ${text(data.recent, 220)}` : ""}`;
      }).join("\n"),
      profile === "strategic",
    );
  }

  const namedProfiles = input.projectRegistry.filter((project) =>
    projectMatches(project, userText),
  ).slice(0, 3);
  if (namedProfiles.length) {
    add(
      "LONG-HORIZON PROJECT INTENT",
      namedProfiles.map((project) => `- ${project.name}: ${text(project.vision, 300)}`).join("\n"),
    );
  }

  const workRelevant = profile === "operational" || profile === "strategic" || PLANNING.test(userText);
  if (workRelevant) {
    const goals = Array.isArray(brain.goals) ? brain.goals : [];
    if (goals.length) {
      add(
        "DURABLE OUTCOMES",
        goals.slice(0, profile === "strategic" ? 8 : 4).map((goal) =>
          `- ${text(goal.project, 48)}: ${text(goal.title, 130)} [${text(goal.status, 32)}, ${Math.max(0, Number(goal.progress ?? 0))}%] — ${text(goal.outcome, 240)}` +
          `${goal.nextAction ? ` Next: ${text(goal.nextAction, 160)}` : ""}` +
          `${goal.blockedBy ? ` Blocked by: ${text(goal.blockedBy, 160)}` : ""}`,
        ).join("\n"),
      );
    }
    const attention = Array.isArray(brain.attention) ? brain.attention : [];
    if (attention.length) {
      add(
        "ATTENTION QUEUE",
        attention.slice(0, 4).map((item) =>
          `- ${text(item.title, 130)} [${text(item.actionClass, 24)} · ${Math.round(Number(item.confidence ?? 0) * 100)}%]: ${text(item.detail, 260)}`,
        ).join("\n"),
      );
    }
    const approvals = Array.isArray(brain.approvals) ? brain.approvals : [];
    if (approvals.length) {
      add("NEEDS DANIEL", approvals.slice(0, 4).map((approval) =>
        `- ${text(approval.jobId, 70)}: ${text(approval.summary, 250)}`,
      ).join("\n"));
    }
    const jobs = Array.isArray(brain.jobs) ? brain.jobs : [];
    if (jobs.length) {
      add("ACTIVE WORK", jobs.slice(0, 5).map((job) =>
        `- ${text(job.agentId ?? "agent", 40)}: ${text(job.label ?? job.task, 140)} (${text(job.stage ?? job.status, 30)}, ${Math.max(0, Number(job.percent ?? 0))}%)`,
      ).join("\n"));
    }
    const missions = Array.isArray(brain.goalMissions) ? brain.goalMissions : [];
    if (missions.length) {
      add("GOAL MODE", missions.slice(0, 5).map((mission) =>
        `- id=${text(mission.id, 70)} “${text(mission.goal, 180)}” [${text(mission.status, 30)}, ${text(mission.phase, 40)}, ${Math.max(0, Number(mission.percent ?? 0))}%]` +
        `${mission.failureReason ? ` Needs attention: ${text(mission.failureReason, 180)}` : ""}`,
      ).join("\n"));
    }
  }

  if (TEAM.test(userText)) {
    const agents = Array.isArray(brain.agents) ? brain.agents : [];
    if (agents.length) {
      add("PERMANENT TEAM", agents.slice(0, 8).map((agent) =>
        `- ${text(agent.name ?? agent.slug, 60)}: ${text(agent.status, 30)}` +
        `${Number(agent.activeJobCount ?? 0) > 0 ? ` · ${Number(agent.activeJobCount)} active` : ""}` +
        `${agent.role ? ` · ${text(agent.role, 150)}` : ""}`,
      ).join("\n"));
    }
  }

  if (TIME.test(userText)) {
    const todos = Array.isArray(hub.todos) ? hub.todos : [];
    const events = Array.isArray(hub.events) ? hub.events : [];
    if (todos.length) add("OPEN TO-DOS", todos.slice(0, 8).map((todo) => `- ${text(todo.text, 180)}`).join("\n"));
    if (events.length) add("CALENDAR", events.slice(0, 8).map((event) =>
      `- ${text(event.title, 120)} on ${new Date(
        typeof event.start === "number" || typeof event.start === "string" ? event.start : 0,
      ).toDateString()}`,
    ).join("\n"));
  }

  if (MONEY.test(userText)) {
    const business = Array.isArray(brain.business) ? brain.business : [];
    if (business.length) add("BUSINESS STATE", business.slice(0, 5).map((item) =>
      `- ${text(item.headline, 150)}${item.detail ? ` — ${text(item.detail, 260)}` : ""}`,
    ).join("\n"));
    if (typeof hub.wealth?.currentTotalGBP === "number") {
      add("WEALTH", `Latest connected net worth: about £${Math.round(hub.wealth.currentTotalGBP).toLocaleString("en-GB")}.`);
    }
  }

  const trip = asRow(brain.trip);
  const tripIsRecent = Number(trip.updatedAt ?? 0) > Date.now() - 14 * 86_400_000;
  if (TRAVEL.test(userText) && trip.data && tripIsRecent) {
    add(
      "TRIP IN PROGRESS",
      `id=${text(trip._id, 80)}. Continue this trip; do not start a duplicate. ${text(trip.data, 1_350)}`,
      true,
    );
  }

  const draft = asRow(brain.draft);
  const draftIsRecent = Number(draft.updatedAt ?? 0) > Date.now() - 2 * 3_600_000;
  if ((DRAFT_EDIT.test(userText) || FOLLOW_UP.test(userText)) && draft.data && draftIsRecent) {
    add(
      "ACTIVE DRAFT",
      `“${text(draft.title, 140)}”. Edit requests refer to this exact text; revise the complete draft rather than creating another. ${text(draft.data, 1_350)}`,
      true,
    );
  }

  const location = asRow(brain.location);
  if (LOCATION.test(userText) && location.value) {
    add("LIVE LOCATION", `${text(location.value, 240)}${location.title ? ` (${text(location.title, 100)})` : ""}`);
  }

  const creations = Array.isArray(brain.creations) ? brain.creations : [];
  if (ARTIFACT.test(userText) || FOLLOW_UP.test(userText)) {
    if (creations.length) add("RECENT ARTIFACTS", creations.slice(0, 5).map((creation) =>
      `- id=${text(creation.id, 50)} ${text(creation.kind, 40)} “${text(creation.title, 120)}”`,
    ).join("\n"));
    if (!lines.some((line) => line.startsWith("DISPLAY CONTEXT"))) {
      const panel = panelSummary(brain.panel);
      if (panel) add("DISPLAY CONTEXT", panel);
    }
  }

  const findings = Array.isArray(brain.findings) ? brain.findings : [];
  if (workRelevant && findings.length) {
    add("VERIFIED WORK RECEIPTS", findings.slice(0, 4).map((finding) =>
      `- ${text(finding.spoken, 330)}`,
    ).join("\n"));
  }

  if (!lines.some((line) => line.startsWith("DISPLAY CONTEXT"))) {
    const panel = panelSummary(brain.panel);
    if (panel && profile !== "reflex") add("DISPLAY CONTEXT", panel);
  }

  return lines.join("\n\n").slice(0, CONTEXT_COMPILER_MAX_CHARS);
}
