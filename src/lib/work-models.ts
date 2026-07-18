export const WORK_MODEL_TIERS = ["luna", "terra", "sol"] as const;

export type WorkModelTier = (typeof WORK_MODEL_TIERS)[number];

// Jobs created before the Codex-only migration can still be in Convex for
// days. Read the old values long enough to finish those leases, but normalize
// every new route, API response and UI label to the Codex catalogue names.
const LEGACY_TIER_ALIASES: Record<string, WorkModelTier> = {
  haiku: "luna",
  sonnet: "terra",
  opus: "sol",
};

export function parseWorkModelTier(value: unknown): WorkModelTier | null {
  const key = String(value ?? "").trim().toLowerCase();
  if ((WORK_MODEL_TIERS as readonly string[]).includes(key)) return key as WorkModelTier;
  if (LEGACY_TIER_ALIASES[key]) return LEGACY_TIER_ALIASES[key];
  if (key.includes("luna")) return "luna";
  if (key.includes("terra")) return "terra";
  if (key.includes("sol")) return "sol";
  return null;
}

export function normalizeWorkModelTier(value: unknown, fallback: WorkModelTier = "terra"): WorkModelTier {
  return parseWorkModelTier(value) ?? fallback;
}

export function workModelLabel(value: unknown): "Luna" | "Terra" | "Sol" {
  const tier = normalizeWorkModelTier(value);
  return tier === "luna" ? "Luna" : tier === "sol" ? "Sol" : "Terra";
}

export function workModelPriority(value: unknown): number {
  const tier = normalizeWorkModelTier(value);
  return tier === "sol" ? 80 : tier === "terra" ? 60 : 45;
}
