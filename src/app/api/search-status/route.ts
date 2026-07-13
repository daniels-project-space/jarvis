import { activeSearchProvider } from "@/lib/search";

// Which search provider is live (serper | serpapi | none) — for the smoke test
// and quick diagnostics after adding a Serper key.
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ provider: await activeSearchProvider() });
}
