import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

// The `claude` binary isn't on PATH in the Trigger image — resolve it from the
// installed @anthropic-ai/claude-code package (mirrors remote-work-hub).
function resolveClaudeBin(): string | null {
  try {
    const pkgJson = nodeRequire.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* ignore */
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}

// Subscription brain: each chat turn runs the real `claude` CLI HEADLESS on
// Daniel's Max subscription (CLAUDE_CODE_OAUTH_TOKEN from the vault, ANTHROPIC_API_KEY
// blanked). Mirrors remote-work-hub's proven pattern; no repo clone/push — this is
// a general assistant, not a coding agent. Memory is injected from Convex.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const RUN_BUDGET_MS = 50_000;
const POLL_MS = 2000;
const IDLE_EXITS = 3;

async function convexMutation(path: string, args: unknown) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()).value;
}
async function convexQuery(path: string, args: unknown) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()).value;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Turn = { finalText: string; sessionId: string | null; code: number | null; stderr: string };

function runTurn(
  bin: string,
  env: NodeJS.ProcessEnv,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
  memoryContext: string,
): Promise<Turn> {
  const preamble =
    "You are JARVIS, Daniel's dry, impeccably-polite British-butler personal ops assistant. " +
    "Be concise — numbers first, no filler. Never fabricate. " +
    (memoryContext ? `Relevant long-term memory:\n${memoryContext}\n` : "") +
    "Answer the user directly.";
  const convo = history.length
    ? "Recent conversation:\n" +
      history.map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n") +
      "\n\n"
    : "";
  const prompt = `${convo}User: ${userText}`;
  const args = [
    "-p",
    prompt,
    "--append-system-prompt",
    preamble,
    "--model",
    "opus",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];
  return new Promise((resolve) => {
    const p = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "",
      finalText = "",
      pending = "",
      stderr = "";
    let sessionId: string | null = null;
    const flush = async () => {
      if (!pending) return;
      const c = pending;
      pending = "";
      await convexMutation("chatQueue:appendChunk", { messageId: assistantId, chunk: c }).catch(() => {});
    };
    const timer = setInterval(() => void flush(), 600);
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id && !sessionId) sessionId = ev.session_id;
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text;
          if (typeof t === "string") pending += t;
        }
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });
    p.on("close", async (code) => {
      clearInterval(timer);
      await flush();
      resolve({ finalText, sessionId, code, stderr: stderr.slice(-400) });
    });
    p.on("error", async (e) => {
      clearInterval(timer);
      await flush();
      resolve({ finalText, sessionId, code: -1, stderr: (stderr + "\n" + e.message).slice(-400) });
    });
  });
}

export const chatDispatcher = schedules.task({
  id: "jarvis-chat-dispatcher",
  cron: "*/1 * * * *",
  maxDuration: 3300,
  run: async () => {
    // CLAUDE_CODE_OAUTH_TOKEN is injected by the Trigger project env (Max sub).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: "/tmp/claude-home",
      ANTHROPIC_API_KEY: "",
    };
    mkdirSync("/tmp/claude-home", { recursive: true });

    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "claude binary not found" };

    const started = Date.now();
    let processed = 0,
      idle = 0;
    while (Date.now() - started < RUN_BUDGET_MS) {
      const claim: any = await convexMutation("chatQueue:claimNext", {});
      if (!claim) {
        idle += 1;
        if (processed === 0 && idle >= IDLE_EXITS) break;
        await sleep(POLL_MS);
        continue;
      }
      idle = 0;
      try {
        const mem: any = await convexQuery("memory:recent", { limit: 8 }).catch(() => []);
        const memoryContext = Array.isArray(mem)
          ? mem.map((m: any) => `- [${m.kind}] ${m.title}: ${m.body}`).join("\n").slice(0, 2000)
          : "";
        const turn = await runTurn(bin, env, claim.assistantId, claim.userText, claim.history, memoryContext);
        const finalText =
          turn.finalText.trim() ||
          (turn.code === 0
            ? "(the agent finished without producing text)"
            : `⚠️ run failed (exit ${turn.code}). ${turn.stderr || ""}`.trim());
        await convexMutation("chatQueue:finalize", {
          messageId: claim.assistantId,
          threadId: claim.threadId,
          status: turn.finalText.trim() ? "done" : "error",
          finalText,
          claudeSessionId: turn.sessionId ?? undefined,
        });
        processed += 1;
      } catch (e: any) {
        await convexMutation("chatQueue:finalize", {
          messageId: claim.assistantId,
          threadId: claim.threadId,
          status: "error",
          finalText: `⚠️ ${e?.message ?? String(e)}`,
        }).catch(() => {});
      }
    }
    return { processed };
  },
});
