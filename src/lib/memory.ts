import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import * as storage from "./storage";

const convexUrl =
  process.env.CONVEX_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  "https://tangible-goose-318.convex.cloud";

function client() {
  return new ConvexHttpClient(convexUrl);
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "note"
  );
}

// Persist a memory. Long bodies go to R2 (r2Key pointer); a distilled copy is
// indexed in Convex for reactive recall.
export async function remember(opts: {
  kind?: string;
  title: string;
  body: string;
  tags?: string[];
}): Promise<{ id: string; r2Key?: string }> {
  const kind = opts.kind ?? "fact";
  let r2Key: string | undefined;
  let indexBody = opts.body;
  if (opts.body.length > 2000) {
    r2Key = `memory/${kind}/${Date.now()}-${slug(opts.title)}.md`;
    await storage.put(r2Key, opts.body, "text/markdown");
    indexBody = opts.body.slice(0, 2000);
  }
  const id = await client().mutation(api.memory.write, {
    kind,
    title: opts.title,
    body: indexBody,
    tags: opts.tags ?? [],
    r2Key,
  });
  return { id: String(id), r2Key };
}

type MemRow = {
  kind: string;
  title: string;
  body: string;
  tags?: string[];
  createdAt: number;
};

export async function recall(opts: {
  query?: string;
  kind?: string;
  limit?: number;
}): Promise<Array<{ kind: string; title: string; body: string; tags: string[]; at: number }>> {
  const c = client();
  const rows: MemRow[] = opts.query
    ? await c.query(api.memory.search, { q: opts.query, limit: opts.limit ?? 12 })
    : await c.query(api.memory.recent, { kind: opts.kind, limit: opts.limit ?? 12 });
  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: r.tags ?? [],
    at: r.createdAt,
  }));
}
