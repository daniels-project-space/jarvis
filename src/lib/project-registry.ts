export type ProjectProfile = {
  slug: string;
  name: string;
  repo: string;
  productionUrl?: string;
  purpose: string;
  objectives: string[];
  invariants: string[];
  related: string[];
};

// Canonical intent is deliberately versioned in code: provider polling owns
// volatile health, while this registry explains what "healthy" is meant to
// achieve. Jarvis can therefore reason about a green deploy that is still not
// advancing the project's actual goal.
export const PROJECT_REGISTRY: ProjectProfile[] = [
  {
    slug: "jarvis",
    name: "Jarvis",
    repo: "daniels-project-space/jarvis",
    productionUrl: "https://jarvis-orcin-six.vercel.app",
    purpose: "Daniel's voice-and-text command centre and autonomous work brain.",
    objectives: ["Replace fragmented work hubs", "Coordinate durable specialist work", "Surface only decisions and opportunities that matter"],
    invariants: ["One personality across voice and text", "Consequential actions require Daniel", "Agents must show evidence and resumable progress"],
    related: ["remote-work-hub", "project-hub", "app-factory-v2"],
  },
  {
    slug: "rental-manager-v2",
    name: "Rental Manager",
    repo: "daniels-project-space/rental-manager-v2",
    productionUrl: "https://rental-manager-v2-nu.vercel.app",
    purpose: "Run DB Cinema and partner Hygglo rental operations from one accurate control plane.",
    objectives: ["Never miss a pickup or return", "Draft excellent renter replies", "Keep fleet and financial analytics truthful and cheap"],
    invariants: ["Rental messages are draft-only until Daniel taps send", "Europe/London drives operations", "Canonical dashboards use materialized bounded reads"],
    related: ["db-cinema-v2", "jarvis"],
  },
  {
    slug: "youtube-studio-ai",
    name: "YouTube Studio AI",
    repo: "daniels-project-space/youtube-studio-ai",
    productionUrl: "https://youtube-studio-ai.vercel.app",
    purpose: "A modular, multi-channel video factory from idea through publish-ready output.",
    objectives: ["Run reliable channel pipelines", "Raise visual and editorial quality", "Make current stage, cost and published output obvious"],
    invariants: ["Never claim failed renders as uploads", "Large render artifacts stay out of Vercel", "Published output needs real provider evidence"],
    related: ["media-engine", "music-house", "jarvis"],
  },
  {
    slug: "app-factory-v2",
    name: "App Factory",
    repo: "daniels-project-space/app-factory-v2",
    productionUrl: "https://app-factory-v2.vercel.app",
    purpose: "Turn promising ideas into genuinely usable, validated cloud applications.",
    objectives: ["Build apps autonomously", "Validate real user journeys", "Forge reusable systems from successful builds"],
    invariants: ["No placeholder success", "Every app owns its cloud stack", "Late gates test the deployed product"],
    related: ["jarvis", "media-engine"],
  },
  {
    slug: "db-cinema-v2",
    name: "DB Cinema",
    repo: "daniels-project-space/db-cinema-v2",
    productionUrl: "https://dbcinemarentals.com",
    purpose: "A cinematic equipment storefront backed by real rental availability.",
    objectives: ["Convert visitors into viable bookings", "Show truthful live availability", "Deliver a distinctive cinematic buying experience"],
    invariants: ["Payments and bookings remain explicitly gated until cutover", "Availability comes from Rental Manager", "No fake inventory state"],
    related: ["rental-manager-v2", "media-engine"],
  },
  {
    slug: "finance-engine-v2",
    name: "Finance Engine",
    repo: "daniels-project-space/finance-engine-v2",
    productionUrl: "https://finance-engine-v2-cyan.vercel.app",
    purpose: "A self-improving crypto strategy research and paper-incubation laboratory.",
    objectives: ["Discover robust strategies", "Reject statistical mirages", "Promote only after sealed and paper evidence"],
    invariants: ["Paper only", "No live execution without explicit connector authorization", "Large market data is precomputed outside dashboard reads"],
    related: ["jarvis", "project-hub"],
  },
  {
    slug: "dropship-ai",
    name: "Dropship AI",
    repo: "daniels-project-space/dropship-ai",
    productionUrl: "https://dropship-ai-cyan.vercel.app",
    purpose: "An organic-first, multi-tenant commerce and content control plane.",
    objectives: ["Find economically viable products", "Create believable product-first media", "Keep publishing and spend reviewable"],
    invariants: ["Verified COGS and contribution margin before launch", "No automatic paid spend", "Publishing follows explicit autonomy gates"],
    related: ["media-engine", "app-factory-v2"],
  },
  {
    slug: "media-engine",
    name: "Media Engine",
    repo: "daniels-project-space/media-engine",
    productionUrl: "https://media-engine-seven.vercel.app",
    purpose: "An autonomous creative and marketing agency for Daniel's portfolio.",
    objectives: ["Understand each product deeply", "Produce coherent campaigns and assets", "Measure real distribution outcomes"],
    invariants: ["Dry-run by default", "Paid spend and publishing stay gated", "Connected metrics replace simulated analytics"],
    related: ["dropship-ai", "youtube-studio-ai", "app-factory-v2"],
  },
  {
    slug: "music-house",
    name: "Music House",
    repo: "daniels-project-space/music-house",
    productionUrl: "https://music-house-nine.vercel.app",
    purpose: "An AI music label with resilient creation, catalog and distribution workflows.",
    objectives: ["Deliver listenable output first", "Backfill lossless/stems/lyrics safely", "Build a durable catalog and audience"],
    invariants: ["Preserve usable audio when enrichment lags", "No claimed distribution without provider evidence", "Media lives in R2"],
    related: ["youtube-studio-ai", "media-engine"],
  },
  {
    slug: "project-hub",
    name: "Project Hub",
    repo: "daniels-project-space/project-hub",
    productionUrl: "https://project-hub-olive-pi.vercel.app",
    purpose: "The portfolio registry, life dashboard and tightly scoped secrets authority.",
    objectives: ["Keep the app catalog truthful", "Expose bounded cross-app context", "Protect and scope credentials"],
    invariants: ["Secrets never reach clients or model sandboxes", "Cross-app reads use dedicated capabilities", "Live provider state wins over catalog claims"],
    related: ["jarvis", "remote-work-hub"],
  },
  {
    slug: "remote-work-hub",
    name: "Remote Work Hub",
    repo: "daniels-project-space/remote-work-hub",
    productionUrl: "https://remote-work-hub-sepia.vercel.app",
    purpose: "Phone-friendly, scoped cloud workspaces across Daniel's repositories.",
    objectives: ["Make remote project work safe and fast", "Provide isolated reproducible workspaces", "Hand central control progressively to Jarvis"],
    invariants: ["Repos are allowlisted", "Credentials stay in the trusted parent", "Workspace progress must be inspectable"],
    related: ["jarvis", "project-hub"],
  },
];

export const PROJECT_BY_SLUG = new Map(PROJECT_REGISTRY.map((project) => [project.slug, project]));
