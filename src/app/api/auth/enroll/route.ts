export const runtime = "nodejs";

// The former long-lived operator-token enrollment boundary is retired. Owner
// browsers are enrolled only by the short-lived, single-use pairing flow.
export async function POST() {
  return Response.json({ ok: false }, { status: 410, headers: { "cache-control": "no-store" } });
}
