import { freshCurrentLocation, freshDeviceLocation } from "./live-location";
import { isConversationalReflex } from "./conversation-intent";

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
  activeTravel?: ContextRow | null;
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

const STRATEGIC = /\b(?:architecture|strategy|portfolio|roadmap|trade-?offs?|compare|decision|design|multi[- ]?(?:repo|project)|root cause|production outage|from first principles|deep dive)\b/i;
const FOCUSED = /\b(?:weather|time|calendar|schedule|todo|remind|price|price of|play|pause|open|show|where|when|who|what is|what's)\b/i;
const PLANNING = /\b(?:plan|build|create|fix|investigate|research|analyse|analyze|recommend|implement|ship|delegate|agent|mission|goal|project)\b/i;
const MONEY = /\b(?:money|wealth|finance|crypto|stock|price|rental|revenue|budget|cost)\b/i;
// Keep the business pulse opt-in and domain-scoped. In particular, media and
// campaign questions should not cause a personal wealth snapshot to be added.
const BUSINESS_PULSE = /\b(?:money|wealth|finance|crypto|stock|price|rental|revenue|budget|cost|you\s*tube|subscriber(?:s|ship)?|channel\s+(?:metrics?|analytics|views?|subscribers?)|(?:video|upload)\s+(?:performance|analytics|pipeline|views?|status|metrics?)|media\b(?!\s+(?:file|upload|asset|library|folder|picker|attachment))|campaigns?|ads?|advertis(?:e|ing|ement|ements)|marketing|distrokid|streams?)\b/i;
const TIME = /\b(?:calendar|schedule|today|tomorrow|week|appointment|remind|todo|to-do)\b/i;
const ARTIFACT = /\b(?:draft|document|board|image|video|chart|scene|mind map|canvas|that one|this one|update it|rework)\b/i;
const FOLLOW_UP = /\b(?:this|that|it|there|second|third|previous|above|on screen|shown)\b/i;
const TRAVEL = /\b(?:trip|travel|flight|hotel|stay|airport|transfer|destination|itinerary)\b/i;
const DRAFT_EDIT = /\b(?:draft|document|write|writing|rewrite|edit|longer|shorter|warmer|tone|wording)\b/i;
const LOCATION = /\b(?:near me|nearby|local|location|directions?|routes?|maps?|places?|attractions?|city|restaurant|weather)\b/i;
const TEAM = /\b(?:agent|team|delegate|mission|goal|working|progress|status)\b/i;
const TRAVEL_BOOKING_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const text = (value: unknown, max: number) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const asRow = (value: unknown): ContextRow =>
  value !== null && typeof value === "object" ? value as ContextRow : {};

const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const placeKey = (value: unknown) =>
  text(value, 180)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-GB")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function routeContext(routeValue: unknown) {
  const route = asRow(routeValue);
  if (text(route.status, 32) !== "ready") return "";
  const mode = text(route.mode, 32) || "route";
  const minutes = finiteNumber(route.durationSeconds);
  const distance = finiteNumber(route.distanceMeters);
  return `${mode}${minutes === undefined ? "" : ` ${Math.max(1, Math.round(minutes / 60))} min`}${distance === undefined ? "" : ` · ${Math.round(distance / 100) / 10} km`}`;
}

/** Compact, trusted travel workspace evidence for later conversational turns. */
function activeTravelContext(value: unknown) {
  const workspace = asRow(value);
  const draftId = text(workspace.draftId, 100);
  const destination = text(workspace.destination, 160);
  if (!draftId || !destination) return "";
  const dates = [text(workspace.departDate, 24), text(workspace.returnDate, 24)].filter(Boolean).join(" → ");
  const itinerary = Array.isArray(workspace.itinerary)
    ? workspace.itinerary.slice(0, 6).flatMap((rawDay) => {
        const day = asRow(rawDay);
        const date = text(day.date, 24) || text(day.label, 80);
        if (!date) return [];
        const items = Array.isArray(day.items)
          ? day.items.slice(0, 6).flatMap((rawItem) => {
              const item = asRow(rawItem);
              const title = text(item.title, 100);
              if (!title) return [];
              const time = text(item.time, 16);
              const duration = finiteNumber(item.durationMinutes);
              return [`${time ? `${time} ` : ""}${title}${duration === undefined ? "" : ` (${Math.max(1, Math.round(duration))} min)`}`];
            })
          : [];
        const route = routeContext(day.route);
        return [`${date}: ${items.length ? items.join(" → ") : "no stops yet"}${route ? ` · ${route}` : ""}`];
      })
    : [];
  const discoveries = Array.isArray(workspace.discoveries)
    ? workspace.discoveries.slice(0, 6).flatMap((rawDiscovery) => {
        const discovery = asRow(rawDiscovery);
        const city = text(discovery.city, 100);
        if (!city) return [];
        const query = text(discovery.query, 100) || "places";
        const itemCount = finiteNumber(discovery.itemCount);
        const route = routeContext(discovery.route);
        return [`${city}: ${query}${itemCount === undefined ? "" : ` (${Math.max(0, Math.round(itemCount))} places)`}${route ? ` · ${route}` : ""}`];
      })
    : [];
  return `draft_id=${draftId}; destination=${destination}${dates ? `; dates=${dates}` : ""}; plan revision ${Math.max(0, Math.round(finiteNumber(workspace.planRevision) ?? 0))}. Continue this exact live globe workspace for every itinerary, place, route, or stay change; never open a duplicate. ${itinerary.length ? `Itinerary: ${itinerary.join(" | ")}.` : ""}${discoveries.length ? ` Saved city explorations: ${discoveries.join(" | ")}.` : ""}`;
}

function matchingTravelBookingReference(value: unknown, userText: string, now = Date.now()) {
  const workspace = asRow(value);
  const references = Array.isArray(workspace.bookingReferences) ? workspace.bookingReferences : [];
  const destinationKey = placeKey(workspace.destination);
  const valid = references.flatMap((rawReference) => {
    const reference = asRow(rawReference);
    const city = text(reference.city, 120);
    const location = text(reference.location, 260);
    const start = finiteNumber(reference.start);
    const end = finiteNumber(reference.end);
    const verifiedAt = finiteNumber(reference.verifiedAt);
    if (!city || !location || start === undefined || end === undefined || end < now || verifiedAt === undefined || verifiedAt > now || now - verifiedAt > TRAVEL_BOOKING_REFERENCE_MAX_AGE_MS) return [];
    return [{
      city,
      location,
      start,
      end,
      verifiedAt,
      title: text(reference.title, 160),
      bookingName: text(reference.bookingName, 160),
      state: start <= now ? "active" : "upcoming",
      timeZone: text(reference.timeZone, 80),
      distanceKm: finiteNumber(reference.distanceKm),
    }];
  });
  if (!valid.length) return undefined;
  const userPlace = placeKey(userText);
  const requestedCity = valid.find((reference) => {
    const city = placeKey(reference.city);
    return city.length >= 3 && userPlace.includes(city);
  });
  if (requestedCity) return requestedCity;
  const destinationReference = valid.find((reference) => placeKey(reference.city) === destinationKey);
  return destinationReference && (destinationKey.length >= 3 && userPlace.includes(destinationKey) || FOLLOW_UP.test(userText))
    ? destinationReference
    : undefined;
}

const rowLine = (row: ContextRow, max = 520) => {
  const source = row?.source ? ` · ${text(row.source, 24)}` : "";
  const confidence = typeof row?.confidence === "number"
    ? ` · ${Math.round(Math.max(0, Math.min(1, row.confidence)) * 100)}%`
    : "";
  const sourceCount = Array.isArray(row?.sourceMessageIds) ? row.sourceMessageIds.length : 0;
  const provenance = sourceCount ? ` · ${sourceCount} source turn${sourceCount === 1 ? "" : "s"}` : "";
  return `- ${text(row?.title, 110)} [${text(row?.kind, 24)}${source}${confidence}${provenance}]: ${text(row?.body, max)}`;
};

export function classifyContextProfile(userText?: string): ContextProfile {
  const value = text(userText, 900);
  if (isConversationalReflex(value)) return "reflex";
  if (STRATEGIC.test(value)) return "strategic";
  if (FOCUSED.test(value) && !PLANNING.test(value)) return "focused";
  return "operational";
}

/**
 * The Project Hub snapshot carries only calendar, to-do, and wealth evidence.
 * Keep it off ordinary substantive turns: compileContext cannot consume it
 * unless the turn matches one of these two existing branches.
 */
export function requiresHubSnapshot(userText?: string): boolean {
  const value = text(userText, 900);
  return TIME.test(value) || MONEY.test(value);
}

function projectMatches(project: unknown, userText: string) {
  const row = asRow(project);
  const data = asRow(row.data);
  const haystack = `${row.slug ?? ""} ${row.name ?? ""} ${row.summary ?? ""} ${data.purpose ?? ""}`.toLowerCase();
  const terms = userText.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 4);
  return terms.some((term) => haystack.includes(term));
}

function relevantBusinessState(business: ContextRow[], userText: string): ContextRow[] {
  const value = userText.toLowerCase();
  const domains = new Set<string>();
  const isYouTube = /\b(?:you\s*tube|subscriber(?:s|ship)?|channel\s+(?:metrics?|analytics|views?|subscribers?)|(?:video|upload)\s+(?:performance|analytics|pipeline|views?|status|metrics?))\b/i.test(value);
  const isMusic = /\b(?:music|distrokid|streams?)\b/i.test(value);
  const isRental = /\b(?:rental|inventory|utili[sz]ation)\b/i.test(value);
  const isMedia = /\bmedia\b(?!\s+(?:file|upload|asset|library|folder|picker|attachment))/i.test(value);
  const isCampaign = /\b(?:campaigns?|ads?|advertis(?:e|ing|ement|ements)|marketing)\b/i.test(value);

  if (isYouTube) domains.add("youtube");
  if (isMusic) domains.add("music");
  if (isRental) domains.add("rental");
  // Campaign and media work is reported through the video and ads snapshots.
  if (isMedia || isCampaign) {
    domains.add("youtube");
    domains.add("ads");
  }

  return domains.size
    ? business.filter((item) => domains.has(text(item.domain, 48).toLowerCase()))
    : business;
}

function panelSummary(value: unknown) {
  const panel = asRow(value);
  if (!panel.type) return "";
  let title = text(panel.title, 160) || text(panel.type, 80);
  if (panel.type === "widget") {
    try {
      const widget = asRow(JSON.parse(String(panel.value)));
      title = text(widget.title ?? widget.kind, 160) || title;
      const activeTool = text(widget.activeTool, 100);
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
      if (activeTool) {
        return `ON SCREEN: ${title} (widget). Active tool: ${activeTool}. For a follow-up, call jarvis_get_tools with activeTool=${activeTool} and update the same overlay.`;
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

  const travelTurn = TRAVEL.test(userText) || LOCATION.test(userText) || FOLLOW_UP.test(userText);
  const activeTravel = asRow(brain.activeTravel);
  const activeTravelWorkspace = travelTurn ? activeTravelContext(activeTravel) : "";
  if (activeTravelWorkspace) {
    add("LIVE TRAVEL WORKSPACE", activeTravelWorkspace, true);
    const booking = matchingTravelBookingReference(activeTravel, userText);
    if (booking) {
      const dates = [new Date(booking.start).toISOString(), new Date(booking.end).toISOString()].join(" → ");
      add(
        "BOOKED STAY REFERENCE",
        `${booking.bookingName || booking.title || "Confirmed stay"} in ${booking.city}: ${booking.location}. ${booking.state}; ${dates}${booking.timeZone ? ` (${booking.timeZone})` : ""}${booking.distanceKm === undefined ? "" : ` · verified ${booking.distanceKm} km from city centre`}. Keep this read-only Gmail stay as the map/reference base for ${booking.city} only; do not treat it as a hotel option or apply it to another city.`,
        true,
      );
    }
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
  const currentPlace = freshCurrentLocation(currentLocation);
  const liveDeviceLocation = freshDeviceLocation(asRow(brain.location));
  // A direct statement can deliberately supersede a GPS sample, but a later
  // device update is authoritative as Daniel moves. Match travel_map's order
  // so voice/text and the visible map never disagree about "near me".
  const useCurrentPlace = currentPlace && (!liveDeviceLocation || currentPlace.observedAt >= liveDeviceLocation.updatedAt)
    ? currentPlace
    : undefined;
  if (useCurrentPlace && travelTurn) {
    add(
      "CURRENT SITUATION",
      `Daniel's current location is ${text(useCurrentPlace.value, 120)} (observed ${new Date(useCurrentPlace.observedAt).toISOString()}). Use it as the default map, weather, route, and nearby-search origin until superseded.`,
      true,
    );
  }
  if (liveDeviceLocation && (!currentPlace || liveDeviceLocation.updatedAt > currentPlace.observedAt) && travelTurn) {
    const label = liveDeviceLocation.label || "Live device location";
    add(
      "LIVE LOCATION",
      `${label} at ${liveDeviceLocation.lat.toFixed(5)}, ${liveDeviceLocation.lng.toFixed(5)} (reported ${new Date(liveDeviceLocation.updatedAt).toISOString()}). Use this freshest device position as the default map, weather, route, and nearby-search origin until superseded.`,
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

  if (BUSINESS_PULSE.test(userText)) {
    const business = Array.isArray(brain.business) ? brain.business : [];
    const relevantBusiness = relevantBusinessState(business, userText);
    if (relevantBusiness.length) add("BUSINESS STATE", relevantBusiness.slice(0, 5).map((item) =>
      `- ${text(item.headline, 150)}${item.detail ? ` — ${text(item.detail, 260)}` : ""}`,
    ).join("\n"));
  }
  if (MONEY.test(userText)) {
    if (typeof hub.wealth?.currentTotalGBP === "number") {
      add("WEALTH", `Latest connected net worth: about £${Math.round(hub.wealth.currentTotalGBP).toLocaleString("en-GB")}.`);
    }
  }

  const trip = asRow(brain.trip);
  const tripIsRecent = Number(trip.updatedAt ?? 0) > Date.now() - 14 * 86_400_000;
  if (TRAVEL.test(userText) && !activeTravelWorkspace && trip.data && tripIsRecent) {
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
