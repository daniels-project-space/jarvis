import type { CompactWorkSnapshot, FleetNode, FleetNodeState } from "./active-work";

export const WORK_MAP_MAX_LEAVES = 4;

export type WorkMapCategoryId = "general" | "projects" | "marketing" | "business" | "research" | "operations";

export type WorkMapLeaf = {
  id: string;
  label: string;
  detail: string;
  state: FleetNodeState | "available";
  working: boolean;
  action: "documents" | "todos" | "work";
  jobId?: string;
};

export type WorkMapBranch = {
  id: string;
  label: string;
  detail: string;
  state: FleetNodeState | "available";
  working: boolean;
  action?: WorkMapLeaf["action"];
  jobId?: string;
  children: WorkMapLeaf[];
  hiddenCount: number;
};

export type WorkMapCategory = {
  id: WorkMapCategoryId;
  label: string;
  detail: string;
  branches: WorkMapBranch[];
  workCount: number;
};

export type WorkMapTodoItem = {
  text: string;
  due?: string | null;
  tags?: string[];
};

export type WorkMapTodoSummary =
  | { state: "loading"; openTodoCount: null; items: WorkMapTodoItem[] }
  | { state: "ready"; openTodoCount: number; items: WorkMapTodoItem[] }
  | { state: "unavailable"; openTodoCount: null; items: WorkMapTodoItem[] };

export type WorkMapInput = {
  documentCount?: number;
  todos?: WorkMapTodoSummary;
};

export type WorkMapVisibilityInput = {
  chatMode: "full" | "bar" | "off";
  live: "off" | "connecting" | "live";
  optionsOpen: boolean;
  stagePanelOpen: boolean;
  commandExpanded: boolean;
  hasBubbles: boolean;
  hasCaption: boolean;
  researching: boolean;
  recording: boolean;
  speaking: boolean;
  hasActiveVideo: boolean;
};

const LIVE_WORK_STATES = new Set<FleetNodeState>([
  "dispatching",
  "running",
  "reviewing",
  "integrating",
]);

const CATEGORY_DETAILS: Record<Exclude<WorkMapCategoryId, "general" | "projects">, string> = {
  marketing: "Campaigns, content, and brand work",
  business: "Commercial and operational work",
  research: "Research, audits, and analysis",
  operations: "Active Jarvis operations",
};

function plural(count: number, singular: string, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function workLabel(label: string) {
  const cleaned = String(label || "Jarvis task")
    .replace(/^(?:jarvis|paul|atlas|iris|maya|sentry)\s*[·:—-]\s*/i, "")
    .replace(/^planning\s*[·:—-]\s*/i, "")
    .replace(/^(?:in|for)\s+(?:daniels-project-space\/)?[a-z0-9._-]+\s*[·:—-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Jarvis task";
}

function nodeOrder(left: FleetNode, right: FleetNode) {
  const activeDelta = Number(isWorkMapNodeWorking(right)) - Number(isWorkMapNodeWorking(left));
  if (activeDelta) return activeDelta;
  const attentionDelta = Number(right.needsDaniel) - Number(left.needsDaniel);
  if (attentionDelta) return attentionDelta;
  return (right.progressAt ?? right.startedAt ?? 0) - (left.progressAt ?? left.startedAt ?? 0)
    || left.jobId.localeCompare(right.jobId);
}

function projectLabel(project: { canonicalProjectId: string; repository: string | null }) {
  const repository = project.repository?.replace(/^daniels-project-space\//, "").trim();
  if (repository) return repository;
  const canonical = project.canonicalProjectId.replace(/^daniels-project-space\//, "").trim();
  return canonical || "Unfiled project";
}

function categoryFor(node: FleetNode): Exclude<WorkMapCategoryId, "general" | "projects"> {
  // The task title/repository express the intended domain. Progress prose can
  // mention incidental work, so it must never re-file a named task.
  const primary = [node.label, node.repository, node.agent].filter(Boolean).join(" ");
  const classify = (basis: string) => {
    if (/\b(?:marketing|campaign|content|brand|social|seo|advert|creative|newsletter)\b/i.test(basis)) return "marketing" as const;
    if (/\b(?:business|sales|client|customer|revenue|finance|invoice|booking|rental|commercial|growth)\b/i.test(basis)) return "business" as const;
    if (/\b(?:research|audit|analysis|investigat|market(?:\s+research)?|compare|evaluate|review)\b/i.test(basis)) return "research" as const;
    return null;
  };
  return classify(primary) ?? "operations";
}

function workLeaf(node: FleetNode): WorkMapLeaf {
  const progress = node.progress.trim() || node.stage.trim() || node.state;
  return {
    id: `work:${node.jobId}`,
    label: workLabel(node.label),
    detail: progress.slice(0, 96),
    state: node.state,
    working: isWorkMapNodeWorking(node),
    action: "work",
    jobId: node.jobId,
  };
}

function relevantNodes(snapshot: CompactWorkSnapshot) {
  const source = snapshot.hierarchy.length
    ? snapshot.hierarchy.flatMap((mission) => mission.projects.flatMap((project) => project.jobs))
    : snapshot.fleet?.nodes ?? [];
  const unique = new Map<string, FleetNode>();
  for (const node of source) {
    if (node.state === "done") continue;
    unique.set(node.jobId, node);
  }
  return [...unique.values()].sort(nodeOrder);
}

/** A worker may intentionally appear in both its project and domain branches. */
export function workMapActiveJobCount(snapshot: CompactWorkSnapshot) {
  return new Set(relevantNodes(snapshot).map((node) => node.jobId)).size;
}

/** The topology yields to every stage surface that would compete for attention. */
export function shouldHideWorkMap(input: WorkMapVisibilityInput) {
  return input.chatMode === "full"
    || input.live !== "off"
    || input.optionsOpen
    || input.stagePanelOpen
    || input.commandExpanded
    || input.hasBubbles
    || input.hasCaption
    || input.researching
    || input.recording
    || input.speaking
    || input.hasActiveVideo;
}

function projectBranches(snapshot: CompactWorkSnapshot, nodes: FleetNode[]) {
  const branches: WorkMapBranch[] = [];
  const seenJobs = new Set<string>();
  const addProject = (project: { id: string; canonicalProjectId: string; repository: string | null; jobs: FleetNode[] }) => {
    const projectNodes = project.jobs.filter((node) => node.state !== "done").sort(nodeOrder);
    if (!projectNodes.length) return;
    projectNodes.forEach((node) => seenJobs.add(node.jobId));
    const children = projectNodes.map(workLeaf);
    branches.push({
      id: `project:${project.id}`,
      label: projectLabel(project),
      detail: plural(children.length, "worker task"),
      state: projectNodes[0]?.state ?? "queued",
      working: projectNodes.some(isWorkMapNodeWorking),
      children: children.slice(0, WORK_MAP_MAX_LEAVES),
      hiddenCount: Math.max(0, children.length - WORK_MAP_MAX_LEAVES),
    });
  };

  snapshot.hierarchy.forEach((mission) => mission.projects.forEach(addProject));
  const fallback = new Map<string, FleetNode[]>();
  for (const node of nodes) {
    if (seenJobs.has(node.jobId)) continue;
    const key = node.repository?.replace(/^daniels-project-space\//, "").trim() || "Unfiled project";
    fallback.set(key, [...(fallback.get(key) ?? []), node]);
  }
  for (const [label, projectNodes] of fallback) {
    const children = projectNodes.map(workLeaf);
    branches.push({
      id: `project:fallback:${label}`,
      label,
      detail: plural(children.length, "worker task"),
      state: projectNodes[0]?.state ?? "queued",
      working: projectNodes.some(isWorkMapNodeWorking),
      children: children.slice(0, WORK_MAP_MAX_LEAVES),
      hiddenCount: Math.max(0, children.length - WORK_MAP_MAX_LEAVES),
    });
  }
  return branches.sort((left, right) => Number(right.working) - Number(left.working) || left.label.localeCompare(right.label));
}

/**
 * Converts the durable fleet projection into a deliberately bounded visual
 * hierarchy. The map never invents work: every work leaf carries a real jobId
 * from the Command Center snapshot, while documents and Hub todos are explicit
 * entry points into their existing surfaces.
 */
export function buildWorkMap(snapshot: CompactWorkSnapshot, input: WorkMapInput = {}): WorkMapCategory[] {
  const documentCount = Math.max(0, Math.floor(input.documentCount ?? 0));
  const todo = input.todos ?? { state: "loading" as const, openTodoCount: null, items: [] };
  const general: WorkMapCategory = {
    id: "general",
    label: "General",
    detail: "Your saved work and daily list",
    workCount: 0,
    branches: [
      {
        id: "general:documents",
        label: "Documents",
        detail: documentCount ? `${plural(documentCount, "saved item")}` : "Saved work library",
        state: "available",
        working: false,
        action: "documents",
        children: [],
        hiddenCount: 0,
      },
      {
        id: "general:todos",
        label: "To-do lists",
        detail: todo.state === "ready"
          ? (todo.openTodoCount ? `${plural(todo.openTodoCount, "open item")}` : "No open items")
          : todo.state === "unavailable"
            ? "Open your list"
            : "Checking your list",
        state: "available",
        working: false,
        action: "todos",
        children: [],
        hiddenCount: 0,
      },
    ],
  };

  const nodes = relevantNodes(snapshot);
  const categories: WorkMapCategory[] = [general];
  const projects = projectBranches(snapshot, nodes);
  if (projects.length) {
    const workCount = projects.reduce((count, branch) => count + branch.children.length + branch.hiddenCount, 0);
    categories.push({
      id: "projects",
      label: "Projects",
      detail: `${plural(projects.length, "project")} with active workers`,
      branches: projects.slice(0, WORK_MAP_MAX_LEAVES),
      workCount,
    });
  }

  const domains = new Map<Exclude<WorkMapCategoryId, "general" | "projects">, FleetNode[]>();
  for (const node of nodes) {
    const category = categoryFor(node);
    domains.set(category, [...(domains.get(category) ?? []), node]);
  }
  (["marketing", "business", "research", "operations"] as const).forEach((id) => {
    const domainNodes = (domains.get(id) ?? []).sort(nodeOrder);
    if (!domainNodes.length) return;
    const branches = domainNodes.map((node) => {
      const leaf = workLeaf(node);
      return {
        id: `domain:${id}:${node.jobId}`,
        label: leaf.label,
        detail: leaf.detail,
        state: leaf.state,
        working: leaf.working,
        action: "work" as const,
        jobId: node.jobId,
        children: [],
        hiddenCount: 0,
      };
    });
    categories.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      detail: CATEGORY_DETAILS[id],
      branches: branches.slice(0, WORK_MAP_MAX_LEAVES),
      workCount: branches.length,
    });
  });
  return categories;
}

export function isWorkMapNodeWorking(node: Pick<FleetNode, "state">) {
  return LIVE_WORK_STATES.has(node.state);
}

/** Keep the lower third free for the opened branch bubble. */
export function workMapPosition(index: number, total: number) {
  const layouts: Record<number, Array<{ x: number; y: number }>> = {
    1: [{ x: 50, y: 23 }],
    2: [{ x: 22, y: 31 }, { x: 78, y: 31 }],
    3: [{ x: 18, y: 36 }, { x: 50, y: 19 }, { x: 82, y: 36 }],
    4: [{ x: 14, y: 36 }, { x: 35, y: 19 }, { x: 65, y: 19 }, { x: 86, y: 36 }],
    5: [{ x: 14, y: 36 }, { x: 32, y: 18 }, { x: 65, y: 18 }, { x: 86, y: 36 }, { x: 21, y: 48 }],
    6: [{ x: 14, y: 37 }, { x: 31, y: 18 }, { x: 64, y: 18 }, { x: 86, y: 37 }, { x: 79, y: 48 }, { x: 21, y: 48 }],
  };
  const safeTotal = Math.min(6, Math.max(1, total));
  return layouts[safeTotal][Math.min(Math.max(0, index), safeTotal - 1)];
}
