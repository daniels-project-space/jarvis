export type CreationFilingInput = {
  kind: string;
  title: string;
  data?: string;
  category?: string;
  folder?: string;
  project?: string;
  inquiry?: string;
};

export type CreationFiling = {
  category: string;
  folder: string;
  project?: string;
  inquiry?: string;
};

const CATEGORY_BY_KIND: Record<string, string> = {
  board: "boards",
  canvas: "mind maps",
  scene: "visual workspaces",
  chart: "charts",
  image: "images",
  pdf: "pdfs",
  trip: "travel plans",
  doc: "documents",
};

const FOLDER_BY_CATEGORY: Record<string, string> = {
  boards: "Visuals / Boards",
  "mind maps": "Visuals / Mind maps",
  "visual workspaces": "Visuals / Workspaces",
  charts: "Data / Charts",
  images: "Media / Images",
  pdfs: "Documents / PDFs",
  emails: "Writing / Emails",
  notes: "Notes / General",
  messages: "Writing / Messages",
  scripts: "Writing / Scripts",
  documents: "Documents / General",
  "travel plans": "Travel / Plans",
};

function tidyLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\\/]+/g, " ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean
    .split(" ")
    .map((part) => (part.length <= 3 && part === part.toUpperCase() ? part : part[0].toUpperCase() + part.slice(1)))
    .join(" ")
    .slice(0, 80);
}

function inferDocCategory(title: string, data?: string): string {
  const sample = `${title}\n${String(data ?? "").slice(0, 500)}`.toLowerCase();
  if (/\b(email|e-mail|subject:|dear |hi [a-z]|hello [a-z]|regards|kind regards)\b/.test(sample)) return "emails";
  if (/\b(note|notes|meeting notes|minutes|scratchpad)\b/.test(sample)) return "notes";
  if (/\b(message|whatsapp|text to|dm to)\b/.test(sample)) return "messages";
  if (/\b(script|screenplay|scene |voiceover|voice-over)\b/.test(sample)) return "scripts";
  return "documents";
}

export function inferCreationFiling(input: CreationFilingInput): CreationFiling {
  const title = String(input.title ?? "Untitled");
  let embedded: { project?: string; inquiry?: string } = {};
  if ((!input.project || !input.inquiry) && input.data?.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(input.data) as { project?: string; inquiry?: string };
      embedded = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      /* non-JSON source */
    }
  }
  const project = tidyLabel(input.project ?? embedded.project);
  let inquiry = tidyLabel(input.inquiry ?? embedded.inquiry);
  const category =
    tidyLabel(input.category)?.toLowerCase() ??
    (input.kind === "doc" ? inferDocCategory(title, input.data) : CATEGORY_BY_KIND[input.kind] ?? "documents");

  if (!inquiry && /\bscavenger(?:\s+hunt)?\b/i.test(`${title} ${input.data ?? ""}`)) inquiry = "Scavenger Hunts";

  const explicitFolder = input.folder
    ?.split("/")
    .map((part) => tidyLabel(part))
    .filter(Boolean)
    .join(" / ");
  const folder = explicitFolder
    ? explicitFolder
    : project
      ? `Projects / ${project}`
      : inquiry
        ? `Inquiries / ${inquiry}`
        : FOLDER_BY_CATEGORY[category] ?? `Library / ${tidyLabel(category) ?? "General"}`;

  return { category, folder, project, inquiry };
}
