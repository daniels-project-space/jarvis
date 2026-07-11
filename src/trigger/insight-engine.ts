import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sendPush } from "./push-send";

// Proactive intelligence: a few times a day, JARVIS looks across all live data
// (rentals, per-item earnings, music, cloud stack, recent agent jobs) and thinks
// about what Daniel should KNOW or ACT on — genuine insights, not a data dump.
// Runs a cheap Sonnet pass on the Max subscription, stores insights, surfaces
// the freshest to chat + phone.

const nodeRequire = createRequire(import.meta.url);
const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

function resolveClaudeBin(): string | null {
  try {
    const pkgJson = nodeRequire.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nm = dirname(dirname(pkgDir));
    const cands = [join(nm, ".bin", "claude")];
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
    if (rel) cands.push(join(pkgDir, rel));
    return cands.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}
async function q(path: string, args: unknown) {
  try {
    return (
      await (
        await fetch(`${CONVEX}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args, format: "json" }),
        })
      ).json()
    ).value;
  } catch {
    return null;
  }
}
async function m(path: string, args: unknown) {
  await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).catch(() => {});
}

function ask(bin: string, env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(bin, ["-p", prompt, "--model", "sonnet", "--dangerously-skip-permissions"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(o);
    }, 120_000);
    p.stdout.on("data", (d) => (o += d.toString()));
    p.on("close", () => {
      clearTimeout(to);
      resolve(o);
    });
    p.on("error", () => {
      clearTimeout(to);
      resolve("");
    });
  });
}

export const insightEngine = schedules.task({
  id: "jarvis-insight-engine",
  cron: "0 8,14,20 * * *", // 3x/day
  maxDuration: 200,
  run: async () => {
    const bin = resolveClaudeBin();
    if (!bin) return { error: "no claude bin" };
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: "/tmp/claude-home", ANTHROPIC_API_KEY: "" };
    mkdirSync("/tmp/claude-home", { recursive: true });

    const biz: any[] = (await q("business:list", {})) ?? [];
    const stack: any[] = (await q("projectState:list", {})) ?? [];
    const jobs: any[] = (await q("jobs:list", { limit: 6 })) ?? [];
    const dataBlob =
      "BUSINESS:\n" +
      biz.map((b) => `- ${b.domain}: ${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n") +
      "\n\nCLOUD STACK:\n" +
      stack.map((s) => `- ${s.slug}: ${s.status}`).join(", ") +
      "\n\nRECENT AGENT JOBS:\n" +
      jobs.map((j) => `- [${j.status}] ${j.task}`).join("\n");

    const prompt =
      "You are JARVIS's proactive-insight engine for Daniel. From the live data below, produce the 1-3 MOST " +
      "useful, SPECIFIC, actionable things Daniel should know or do right now — genuine insight, not a summary " +
      "(spot opportunities, risks, idle assets costing money, anomalies, wins worth noting). Each must reference " +
      "real numbers/names from the data. Write each as ONE natural spoken sentence, no markdown, no emoji. " +
      'Output STRICT JSON only: [{"text":"...","severity":"info|opportunity|warning"}]. Empty [] if nothing ' +
      "genuinely noteworthy.\n\n" +
      dataBlob;

    const out = await ask(bin, env, prompt);
    const match = out.match(/\[[\s\S]*\]/);
    if (!match) return { insights: 0 };
    let items: any[] = [];
    try {
      items = JSON.parse(match[0]);
    } catch {
      return { insights: 0 };
    }
    const kept = (Array.isArray(items) ? items : []).filter((i) => i?.text).slice(0, 3);
    for (const it of kept) {
      await m("business:addInsight", {
        domain: "cross",
        text: String(it.text).slice(0, 400),
        severity: ["info", "opportunity", "warning"].includes(it.severity) ? it.severity : "info",
      });
    }
    // Surface the single most important fresh insight proactively (chat + phone).
    const top = kept.find((i) => i.severity === "warning") ?? kept.find((i) => i.severity === "opportunity") ?? kept[0];
    if (top) {
      await m("chatQueue:postAssistant", { threadId: "main", text: `A thought, sir — ${top.text}` });
      await sendPush("JARVIS — a thought", String(top.text).slice(0, 140), "/");
    }
    return { insights: kept.length };
  },
});
