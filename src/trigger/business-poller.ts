import { schedules } from "@trigger.dev/sdk/v3";

// Connected intelligence: pulls REAL business metrics from Daniel's other Convex
// deployments (rental-manager, music-house) into per-domain snapshots on JARVIS's
// own Convex, so the brain naturally knows how everything is doing. Read-only.

const JARVIS = "https://tangible-goose-318.convex.cloud";
const RENTAL = "https://hearty-oyster-600.convex.cloud";
const MUSIC = "https://determined-aardvark-936.convex.cloud";
const YOUTUBE = "https://astute-camel-689.convex.cloud";

type UpstreamRead =
  | { available: true; value: unknown }
  | { available: false; reason: string };

export type BusinessPollResult = {
  domain: "rental" | "music" | "youtube" | "ads";
  status: "updated" | "empty" | "unavailable" | "unconfigured";
  reason?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const numberValue = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const unavailable = (reason: string): UpstreamRead => ({ available: false, reason });

async function convexQuery(url: string, path: string, args: unknown): Promise<UpstreamRead> {
  try {
    const r = await fetch(`${url}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    if (!r.ok) return unavailable(`upstream HTTP ${r.status}`);
    let payload: unknown;
    try {
      payload = await r.json();
    } catch {
      return unavailable("upstream returned invalid JSON");
    }
    if (!isRecord(payload)) return unavailable("upstream returned an invalid JSON envelope");
    if (payload.status !== undefined && payload.status !== "success") {
      return unavailable(`upstream returned status ${String(payload.status).slice(0, 80)}`);
    }
    if (!Object.hasOwn(payload, "value")) return unavailable("upstream response omitted value");
    return { available: true, value: payload.value };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message.slice(0, 160) : "upstream request failed");
  }
}

async function jarvisMutation(path: string, args: unknown): Promise<boolean> {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  try {
    const response = await fetch(`${JARVIS}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const shortName = (s: unknown) =>
  String(s || "")
    .split(/[|,\n]/)[0]
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .slice(0, 42)
    .trim();

const upstreamUnavailable = (
  domain: BusinessPollResult["domain"],
  reads: UpstreamRead[],
): BusinessPollResult | null => {
  const failed = reads.find((read) => !read.available);
  return failed && !failed.available
    ? { domain, status: "unavailable", reason: failed.reason }
    : null;
};

const snapshotWriteResult = (
  domain: BusinessPollResult["domain"],
  saved: boolean,
): BusinessPollResult => saved
  ? { domain, status: "updated" }
  : { domain, status: "unavailable", reason: "JARVIS snapshot write failed" };

export async function pollRental(): Promise<BusinessPollResult> {
  const reads = await Promise.all([
    convexQuery(RENTAL, "mv/stats_drawer:get", { account: "all" }),
    convexQuery(RENTAL, "mv/top_earners:getRanking", { account: "all", limit: 8 }),
    convexQuery(RENTAL, "mv/earnings_by_period:get", { account: "all", granularity: "monthly", months: 6 }),
  ]);
  const failed = upstreamUnavailable("rental", reads);
  if (failed) return failed;
  const [statsRow, top, series] = reads.map((read) => read.available ? read.value : undefined);
  if (statsRow === null) return { domain: "rental", status: "empty" };
  if (!isRecord(statsRow) || !isRecord(statsRow.payload) || !Array.isArray(top) || !Array.isArray(series)) {
    return { domain: "rental", status: "unavailable", reason: "rental response shape was invalid" };
  }
  const stats = statsRow.payload;

  const m = asRecord(stats.monthly);
  const act = asRecord(stats.active);
  const worth = numberValue(asRecord(stats.inventory_worth).total_gbp);
  const earners: unknown[] = top;
  const topLine = earners
    .slice(0, 3)
    .map((value) => {
      const earner = asRecord(value);
      return `${shortName(earner.itemName)} ${gbp(numberValue(earner.net30dGbp))}`;
    })
    .join(", ");
  const topEarner = earners.length ? asRecord(earners[0]) : null;

  const headline =
    `Rentals: ${gbp(numberValue(m.current_earnings))} earned this month, ${numberValue(act.ongoing_count)} active / ` +
    `${numberValue(act.upcoming_count)} upcoming. Inventory worth ${gbp(worth)}.`;
  const detail =
    `Top earners (30d): ${topLine}. ` +
    (topEarner
      ? `Best per-item: ${shortName(topEarner.itemName)} at ${gbp(numberValue(topEarner.net30dGbp))} from ${numberValue(topEarner.rentalCount)} rentals (${Math.round(numberValue(topEarner.utilizationPct))}% used).`
      : "");
  const saved = await jarvisMutation("business:upsert", {
    domain: "rental",
    headline,
    detail,
    data: {
      monthEarnings: numberValue(m.current_earnings),
      active: numberValue(act.ongoing_count),
      upcoming: numberValue(act.upcoming_count),
      inventoryWorth: worth,
      monthlyRevenue: (series as unknown[]).slice(-7).map((value) => {
        const point = asRecord(value);
        return { period: point.period, revenue: numberValue(point.revenue) };
      }),
      topEarners: earners.slice(0, 8).map((value) => {
        const earner = asRecord(value);
        return {
          name: shortName(earner.itemName),
          net30d: numberValue(earner.net30dGbp),
          rentals: numberValue(earner.rentalCount),
          utilPct: numberValue(earner.utilizationPct),
        };
      }),
    },
  });
  return snapshotWriteResult("rental", saved);
}

export async function pollMusic(): Promise<BusinessPollResult> {
  const read = await convexQuery(MUSIC, "distributorAnalytics:latest", { distributor: "distrokid" });
  if (!read.available) return { domain: "music", status: "unavailable", reason: read.reason };
  const d = read.value;
  if (d === null) return { domain: "music", status: "empty" };
  if (!isRecord(d)) return { domain: "music", status: "unavailable", reason: "music response shape was invalid" };
  const music = d;
  const balance = numberValue(music.balance);
  const streams = numberValue(music.streamsTotal);
  const headline =
    `Music (DistroKid): ${gbp(balance)} balance, ${streams.toLocaleString("en-GB")} total streams.`;
  const saved = await jarvisMutation("business:upsert", {
    domain: "music",
    headline,
    detail: music.message ? String(music.message).slice(0, 200) : "",
    data: { balance, streams, currency: music.currency },
  });
  return snapshotWriteResult("music", saved);
}

export async function pollYouTube(): Promise<BusinessPollResult> {
  const ownerId = "owner_daniel";
  const reads = await Promise.all([
    convexQuery(YOUTUBE, "analytics:overview", { ownerId }),
    convexQuery(YOUTUBE, "videos:listVideos", { ownerId, limit: 12 }),
    convexQuery(YOUTUBE, "runs:listActive", { ownerId }),
    convexQuery(YOUTUBE, "runs:listRecent", { ownerId, limit: 12 }),
  ]);
  const failed = upstreamUnavailable("youtube", reads);
  if (failed) return failed;
  const [ov, videos, active, recent] = reads.map((read) => read.available ? read.value : undefined);
  // A successful `null` overview is the provider's explicit no-channel state.
  // Transport, status, JSON, and shape failures return above and must preserve
  // the last known snapshot rather than looking like a disconnected channel.
  if (!Array.isArray(videos) || !Array.isArray(active) || !Array.isArray(recent)) {
    return { domain: "youtube", status: "unavailable", reason: "YouTube response shape was invalid" };
  }
  if (ov === null) {
    const saved = await jarvisMutation("business:upsert", {
      domain: "youtube",
      headline:
        "No YouTube channel is linked yet, so I can't see views or subscribers. Link one and I'll start tracking it.",
      data: { channels: 0 },
    });
    return saved
      ? { domain: "youtube", status: "empty" }
      : { domain: "youtube", status: "unavailable", reason: "JARVIS snapshot write failed" };
  }
  if (!isRecord(ov)) {
    return { domain: "youtube", status: "unavailable", reason: "YouTube response shape was invalid" };
  }
  const overview = ov;
  {
    const channelCount = numberValue(overview.channelCount);
    const totalSubscribers = numberValue(overview.totalSubscribers);
    const totalViews = numberValue(overview.totalViews);
    const headline =
      `YouTube: ${channelCount} channel${channelCount === 1 ? "" : "s"}, ` +
      `${totalSubscribers.toLocaleString("en-GB")} subscribers, ` +
      `${totalViews.toLocaleString("en-GB")} total views.`;
    const now = Date.now();
    const uploads = (videos as unknown[])
      .slice(0, 6)
      .map((value) => {
        const video = asRecord(value);
        const youtubeVideoId = String(video.youtubeVideoId ?? "");
        return youtubeVideoId
          ? {
            runId: String(video._id ?? ""),
            youtubeVideoId,
            title: String(video.title ?? "Published video").slice(0, 160),
            channelName: String(video.channelName ?? "").slice(0, 80),
            channelSlug: String(video.channelSlug ?? "").slice(0, 80),
            publishedAt: video.finishedAt ?? video.createdAt,
            durationSec: video.durationSec,
            thumbnailUrl: `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`,
          }
          : null;
      })
      .filter((upload): upload is NonNullable<typeof upload> => upload !== null);
    const activeRuns = (active as unknown[]).slice(0, 12).map((value) => {
      const run = asRecord(value);
      const startedAt = numberValue(run.startedAt);
      const ageMs = startedAt ? Math.max(0, now - startedAt) : 0;
      return {
        runId: String(run._id ?? ""),
        status: String(run.status ?? "unknown"),
        channelName: String(run.channelName ?? "").slice(0, 80),
        startedAt,
        ageMs,
        stale: ageMs > 6 * 3600_000,
      };
    });
    const recentRows: unknown[] = recent;
    const saved = await jarvisMutation("business:upsert", {
      domain: "youtube",
      headline,
      detail: `${uploads.length} recent published upload${uploads.length === 1 ? "" : "s"}; ${activeRuns.filter((run) => !run.stale).length} genuinely active, ${activeRuns.filter((run) => run.stale).length} stale pipeline record${activeRuns.filter((run) => run.stale).length === 1 ? "" : "s"} needing attention.`,
      data: {
        ...overview,
        uploads,
        activeRuns,
        summary: {
          active: activeRuns.filter((run) => !run.stale).length,
          stale: activeRuns.filter((run) => run.stale).length,
          failedRecent: recentRows.filter((value) => {
            const run = asRecord(value);
            return run.status === "failed" || run.status === "error";
          }).length,
          publishedRecent: recentRows.filter((value) => Boolean(asRecord(value).youtubeVideoId)).length,
        },
      },
    });
    return snapshotWriteResult("youtube", saved);
  }
}

export async function pollAds(): Promise<BusinessPollResult> {
  // No ad platform is connected in the vault (no Google Ads / Meta). State it plainly.
  const saved = await jarvisMutation("business:upsert", {
    domain: "ads",
    headline:
      "No ad accounts are connected yet, so there's no ad performance to report. Wire up Google Ads or Meta and I'll watch it for you.",
    data: { connected: false },
  });
  return saved
    ? { domain: "ads", status: "unconfigured" }
    : { domain: "ads", status: "unavailable", reason: "JARVIS snapshot write failed" };
}

export const businessPoller = schedules.task({
  id: "jarvis-business-poller",
  cron: "0 */8 * * *",
  maxDuration: 120,
  run: async () => {
    const results = await Promise.all([pollRental(), pollMusic(), pollYouTube(), pollAds()]);
    return { polled: ["rental", "music", "youtube", "ads"], results };
  },
});
