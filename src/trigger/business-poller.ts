import { schedules } from "@trigger.dev/sdk/v3";

// Connected intelligence: pulls REAL business metrics from Daniel's other Convex
// deployments (rental-manager, music-house) into per-domain snapshots on JARVIS's
// own Convex, so the brain naturally knows how everything is doing. Read-only.

const JARVIS = "https://tangible-goose-318.convex.cloud";
const RENTAL = "https://hearty-oyster-600.convex.cloud";
const MUSIC = "https://determined-aardvark-936.convex.cloud";
const YOUTUBE = "https://astute-camel-689.convex.cloud";

async function convexQuery(url: string, path: string, args: unknown) {
  try {
    const r = await fetch(`${url}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}
async function jarvisMutation(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  await fetch(`${JARVIS}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
  }).catch(() => {});
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const shortName = (s: string) =>
  String(s || "")
    .split(/[|,\n]/)[0]
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .slice(0, 42)
    .trim();

async function pollRental() {
  const stats: any = await convexQuery(RENTAL, "dashboard:getStatsDrawerData", {
    accountSlug: "db",
    _bypassMv: true,
  });
  const top: any = await convexQuery(RENTAL, "mv/top_earners:getRanking", {});
  const util: any = await convexQuery(RENTAL, "mv/utilization:get", {});
  if (!stats) return;

  const m = stats.monthly ?? {};
  const act = stats.active ?? {};
  const worth = stats.inventory_worth?.total_gbp ?? 0;
  const fleet = util?.fleetUtilizationPct ?? 0;
  const earners = Array.isArray(top) ? top : [];
  const topLine = earners
    .slice(0, 3)
    .map((e: any) => `${shortName(e.itemName)} ${gbp(e.net30dGbp)}`)
    .join(", ");

  const headline =
    `Rentals: ${gbp(m.current_earnings ?? 0)} earned this month, ${act.ongoing_count ?? 0} active / ` +
    `${act.upcoming_count ?? 0} upcoming, fleet utilisation ${Math.round(fleet)}%. Inventory worth ${gbp(worth)}.`;
  const detail =
    `Top earners (30d): ${topLine}. ` +
    (earners.length
      ? `Best per-item: ${shortName(earners[0].itemName)} at ${gbp(earners[0].net30dGbp)} from ${earners[0].rentalCount} rentals (${Math.round(earners[0].utilizationPct)}% used).`
      : "");
  await jarvisMutation("business:upsert", {
    domain: "rental",
    headline,
    detail,
    data: {
      monthEarnings: m.current_earnings ?? 0,
      active: act.ongoing_count ?? 0,
      upcoming: act.upcoming_count ?? 0,
      fleetUtilPct: fleet,
      inventoryWorth: worth,
      topEarners: earners.slice(0, 8).map((e: any) => ({
        name: shortName(e.itemName),
        net30d: e.net30dGbp,
        rentals: e.rentalCount,
        utilPct: e.utilizationPct,
      })),
    },
  });
}

async function pollMusic() {
  const d: any = await convexQuery(MUSIC, "distributorAnalytics:latest", { distributor: "distrokid" });
  if (!d) return;
  const headline =
    `Music (DistroKid): ${gbp(d.balance ?? 0)} balance, ${(d.streamsTotal ?? 0).toLocaleString("en-GB")} total streams.`;
  await jarvisMutation("business:upsert", {
    domain: "music",
    headline,
    detail: d.message ? String(d.message).slice(0, 200) : "",
    data: { balance: d.balance ?? 0, streams: d.streamsTotal ?? 0, currency: d.currency },
  });
}

async function pollYouTube() {
  // Channels table may be unpopulated (rebuild early-stage) — light up automatically
  // once a channel is linked; until then, be honest rather than fabricate.
  let ov: any = null;
  for (const owner of ["o", "default", "owner_test", ""]) {
    const r: any = await convexQuery(YOUTUBE, "analytics:overview", { ownerId: owner });
    if (r && (r.channelCount ?? 0) > 0) {
      ov = r;
      break;
    }
  }
  if (ov) {
    const headline =
      `YouTube: ${ov.channelCount} channel${ov.channelCount === 1 ? "" : "s"}, ` +
      `${(ov.totalSubscribers ?? 0).toLocaleString("en-GB")} subscribers, ` +
      `${(ov.totalViews ?? 0).toLocaleString("en-GB")} total views.`;
    await jarvisMutation("business:upsert", { domain: "youtube", headline, data: ov });
  } else {
    await jarvisMutation("business:upsert", {
      domain: "youtube",
      headline:
        "No YouTube channel is linked yet, so I can't see views or subscribers. Link one and I'll start tracking it.",
      data: { channels: 0 },
    });
  }
}

async function pollAds() {
  // No ad platform is connected in the vault (no Google Ads / Meta). State it plainly.
  await jarvisMutation("business:upsert", {
    domain: "ads",
    headline:
      "No ad accounts are connected yet, so there's no ad performance to report. Wire up Google Ads or Meta and I'll watch it for you.",
    data: { connected: false },
  });
}

export const businessPoller = schedules.task({
  id: "jarvis-business-poller",
  cron: "*/30 * * * *",
  maxDuration: 120,
  run: async () => {
    await Promise.all([pollRental(), pollMusic(), pollYouTube(), pollAds()]);
    return { polled: ["rental", "music", "youtube", "ads"] };
  },
});
