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
  const [statsRow, top, series]: any[] = await Promise.all([
    convexQuery(RENTAL, "mv/stats_drawer:get", { account: "all" }),
    convexQuery(RENTAL, "mv/top_earners:getRanking", { account: "all", limit: 8 }),
    convexQuery(RENTAL, "mv/earnings_by_period:get", { account: "all", granularity: "monthly", months: 6 }),
  ]);
  const stats: any = statsRow?.payload;
  if (!stats) return;

  const m = stats.monthly ?? {};
  const act = stats.active ?? {};
  const worth = stats.inventory_worth?.total_gbp ?? 0;
  const earners = Array.isArray(top) ? top : [];
  const topLine = earners
    .slice(0, 3)
    .map((e: any) => `${shortName(e.itemName)} ${gbp(e.net30dGbp)}`)
    .join(", ");

  const headline =
    `Rentals: ${gbp(m.current_earnings ?? 0)} earned this month, ${act.ongoing_count ?? 0} active / ` +
    `${act.upcoming_count ?? 0} upcoming. Inventory worth ${gbp(worth)}.`;
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
      inventoryWorth: worth,
      monthlyRevenue: (Array.isArray(series) ? series : []).slice(-7).map((point: any) => ({
        period: point.period,
        revenue: point.revenue ?? 0,
      })),
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
  const ownerId = "owner_daniel";
  const [ov, videos, active, recent]: any[] = await Promise.all([
    convexQuery(YOUTUBE, "analytics:overview", { ownerId }),
    convexQuery(YOUTUBE, "videos:listVideos", { ownerId, limit: 12 }),
    convexQuery(YOUTUBE, "runs:listActive", { ownerId }),
    convexQuery(YOUTUBE, "runs:listRecent", { ownerId, limit: 12 }),
  ]);
  if (ov) {
    const headline =
      `YouTube: ${ov.channelCount} channel${ov.channelCount === 1 ? "" : "s"}, ` +
      `${(ov.totalSubscribers ?? 0).toLocaleString("en-GB")} subscribers, ` +
      `${(ov.totalViews ?? 0).toLocaleString("en-GB")} total views.`;
    const now = Date.now();
    const uploads = (Array.isArray(videos) ? videos : [])
      .filter((video: any) => video.youtubeVideoId)
      .slice(0, 6)
      .map((video: any) => ({
        runId: String(video._id),
        youtubeVideoId: String(video.youtubeVideoId),
        title: String(video.title ?? "Published video").slice(0, 160),
        channelName: String(video.channelName ?? "").slice(0, 80),
        channelSlug: String(video.channelSlug ?? "").slice(0, 80),
        publishedAt: video.finishedAt ?? video.createdAt,
        durationSec: video.durationSec,
        thumbnailUrl: `https://img.youtube.com/vi/${video.youtubeVideoId}/mqdefault.jpg`,
      }));
    const activeRuns = (Array.isArray(active) ? active : []).slice(0, 12).map((run: any) => {
      const startedAt = Number(run.startedAt ?? 0);
      const ageMs = startedAt ? Math.max(0, now - startedAt) : 0;
      return {
        runId: String(run._id),
        status: String(run.status ?? "unknown"),
        channelName: String(run.channelName ?? "").slice(0, 80),
        startedAt,
        ageMs,
        stale: ageMs > 6 * 3600_000,
      };
    });
    const recentRows = Array.isArray(recent) ? recent : [];
    await jarvisMutation("business:upsert", {
      domain: "youtube",
      headline,
      detail: `${uploads.length} recent published upload${uploads.length === 1 ? "" : "s"}; ${activeRuns.filter((run: any) => !run.stale).length} genuinely active, ${activeRuns.filter((run: any) => run.stale).length} stale pipeline record${activeRuns.filter((run: any) => run.stale).length === 1 ? "" : "s"} needing attention.`,
      data: {
        ...ov,
        uploads,
        activeRuns,
        summary: {
          active: activeRuns.filter((run: any) => !run.stale).length,
          stale: activeRuns.filter((run: any) => run.stale).length,
          failedRecent: recentRows.filter((run: any) => run.status === "failed" || run.status === "error").length,
          publishedRecent: recentRows.filter((run: any) => run.youtubeVideoId).length,
        },
      },
    });
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
  // Rental, music, YouTube and ads metrics are slow-moving; alerting remains
  // event-driven elsewhere, so this is a four-hourly reconciliation sweep.
  cron: "0 */8 * * *",
  maxDuration: 120,
  run: async () => {
    await Promise.all([pollRental(), pollMusic(), pollYouTube(), pollAds()]);
    return { polled: ["rental", "music", "youtube", "ads"] };
  },
});
