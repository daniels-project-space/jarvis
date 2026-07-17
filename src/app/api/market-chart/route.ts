import type { NextRequest } from "next/server";
import { adminSessionHash, isSameOriginRequest, validateAdminSession } from "@/lib/control-session";
import { chartWidget, fetchCandles, keyLevels, resolveAsset } from "@/lib/markets";

export const runtime = "nodejs";
export const maxDuration = 8;

// The visual shortcut is deliberately independent of the agent/tool queue:
// it gives the screen something useful to render immediately, while the full
// analyst remains available for questions that actually need reasoning.
export async function GET(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const auth = await adminSessionHash(req);
  if (!(await validateAdminSession(auth))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const asset = resolveAsset(params.get("asset") ?? "");
  const requestedInterval = params.get("interval") ?? "1d";
  const interval = ["1h", "4h", "1d", "1w"].includes(requestedInterval) ? requestedInterval : "1d";
  if (!asset) return Response.json({ error: "unknown asset" }, { status: 400 });
  const candles = await fetchCandles(asset, interval);
  if (candles.length < 30) return Response.json({ error: "market data unavailable" }, { status: 502 });
  const widget = chartWidget(asset, interval, candles, keyLevels(candles));
  return Response.json({ widget }, { headers: { "cache-control": "private, no-store" } });
}
