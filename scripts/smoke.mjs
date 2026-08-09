#!/usr/bin/env node
// JARVIS nightly smoke test — runs against prod, cleans up after itself, and
// files failures into the Convex `incidents` table so the self-repair healer
// picks them up automatically. Zero dependencies (global fetch only).
//
//   node scripts/smoke.mjs            # full run
//   BASE=... CONVEX=... node scripts/smoke.mjs
//
// If scheduled, run this only from a managed cloud scheduler. Keep tests FAST,
// IDEMPOTENT and side-effect-free outside the "smoke" thread.

const BASE = process.env.BASE ?? "https://jarvis-orcin-six.vercel.app";
const CV = (process.env.CONVEX ?? "https://tangible-goose-318.convex.cloud") + "/api";
const THREAD = "smoke";
const DISPATCH_TOKEN = process.env.JARVIS_DISPATCH_TOKEN ?? "";
let VIEWER_TOKEN = "";

async function authenticate() {
  // Jarvis is deliberately open: viewer bootstrap creates or refreshes the
  // long-lived owner session. Exercising the retired password-login route made
  // the monitor report a false outage while real browsers worked correctly.
  const viewer = await fetch(`${BASE}/api/auth/viewer`, {
    method: "POST",
    headers: { origin: BASE, "x-jarvis-embed": "1" },
  });
  const payload = await viewer.json().catch(() => ({}));
  VIEWER_TOKEN = payload.viewerToken ?? "";
  if (!viewer.ok || !VIEWER_TOKEN) {
    throw new Error(`JARVIS open viewer bootstrap failed (${viewer.status})`);
  }
}

const results = [];
// External-quota / rate-limit failures are billing, not bugs — mark SKIP so
// they never spam the self-repair pipeline. (SerpAPI "run out of searches",
// Anthropic 429, etc.)
const EXTERNAL = /run out of searches|rate.?limit|quota|429|credit balance|insufficient|payment required|402/i;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (EXTERNAL.test(msg)) {
      results.push({ name, ok: true, skipped: true, ms: Date.now() - t0 });
      console.log(`SKIP  ${name}: external quota/limit — ${msg.slice(0, 80)}`);
      return;
    }
    results.push({ name, ok: false, ms: Date.now() - t0, err: msg.slice(0, 300) });
    console.log(`FAIL  ${name}: ${msg}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function cv(kind, path, args) {
  if (kind === "mutation") {
    const r = await fetch(`${BASE}/api/client-mutation`, {
      method: "POST",
      // Deliberately omit the admin cookie: this is the Project Hub iframe
      // transport, where third-party cookies may be blocked by the browser.
      headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}`, origin: BASE },
      body: JSON.stringify({ path, args }),
    });
    const j = await r.json();
    if (!r.ok || j.ok !== true) throw new Error(`${path}: private mutation rejected (${r.status})`);
    return j.value;
  }
  const r = await fetch(`${CV}/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VIEWER_TOKEN}`,
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(`${path}: ${String(j.errorMessage).slice(0, 160)}`);
  return j.value;
}
async function chat(text) {
  const requestId = `smoke-${crypto.randomUUID()}`;
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}` },
    body: JSON.stringify({ text, threadId: THREAD, requestId }),
    signal: AbortSignal.timeout(30_000),
  });
  const queued = await r.json();
  if (!r.ok || queued.ok !== true) return queued;

  // /api/chat only commits and wakes the durable subscription worker. Follow
  // the exact request-id/parent-id pair just like the realtime UI does.
  const deadline = Date.now() + 115_000;
  while (Date.now() < deadline) {
    const rows = await cv("query", "chatQueue:listMessages", { threadId: THREAD });
    const user = rows.find((row) => row.role === "user" && row.requestId === requestId);
    const answer = user && rows.find((row) => row.role === "assistant" && row.parentMessageId === user._id);
    if (answer?.status === "done") return { ...queued, text: answer.text };
    if (answer?.status === "error") return { ...queued, ok: false, error: "worker turn failed" };
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { ...queued, ok: false, error: "timed out waiting for streamed answer" };
}
async function tool(name, args) {
  const r = await fetch(`${BASE}/api/tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}` },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(115_000),
  });
  return String((await r.json()).result ?? "");
}

await authenticate();

// ---------------------------------------------------------------------------
await test("live voice round-trips a deterministic spoken phrase", async () => {
  const phrase = "Jarvis speech check number seven";
  // Use Jarvis's real production voice so this remains a text-only, portable
  // smoke fixture. The phrase is deliberately short: one free TTS request and
  // one bounded STT request validate the full audio path without repeated cost.
  const speech = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VIEWER_TOKEN}`,
      origin: BASE,
    },
    body: JSON.stringify({ text: phrase }),
    signal: AbortSignal.timeout(15_000),
  });
  assert(speech.status === 200, `TTS fixture returned ${speech.status}`);
  const audio = Buffer.from(await speech.arrayBuffer());
  assert(audio.length > 2_000, `TTS fixture was unexpectedly short (${audio.length} bytes)`);
  const mime = (speech.headers.get("content-type") ?? "audio/mpeg").split(";")[0];
  const r = await fetch(`${BASE}/api/stt`, {
    method: "POST",
    headers: { "content-type": mime, authorization: `Bearer ${VIEWER_TOKEN}` },
    body: audio,
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await r.json().catch(() => null);
  assert(r.status === 200, `STT provider/config probe returned ${r.status}: ${JSON.stringify(payload)}`);
  assert(["local-faster-whisper", "groq-whisper"].includes(r.headers.get("x-jarvis-stt-provider")),
    "STT returned 200 without reaching a configured provider");
  const transcript = String(payload?.text ?? "").toLowerCase();
  const concepts = [/\bjarvis\b/, /\b(speech|voice)\b/, /\b(check|verify|verification)\b/, /\b(seven|7)\b/];
  const matched = concepts.filter((pattern) => pattern.test(transcript)).length;
  assert(matched >= 3 && concepts[0].test(transcript),
    `STT transcript did not match spoken fixture: ${JSON.stringify(payload?.text ?? "")}`);
});

await test("chat answers, clean text", async () => {
  const j = await chat("quick smoke check — reply with one short sentence");
  assert(j.ok === true, `ok=${j.ok} ${j.error ?? ""}`);
  assert(j.text && j.text.length > 2, "empty answer");
  assert(!/<function|\{"kind"\s*:/.test(j.text), `tool garbage in reply: ${j.text.slice(0, 80)}`);
});

await test("weather ask routes to the weather tool + widget panel", async () => {
  const j = await chat("show me the weather");
  assert(j.ok === true && j.text, `answer=${j.error ?? "empty"}`);
  const p = await cv("query", "ui:getPanel", {});
  assert(p && p.type === "widget" && p.value.includes('"kind":"weather"'), `panel=${p?.title}`);
});

await test("youtube ask routes to the video lineup", async () => {
  const j = await chat("show me videos of lofi girl");
  assert(j.ok === true && j.text, `answer=${j.error ?? "empty"}`);
  const p = await cv("query", "ui:getPanel", {});
  assert(p && p.value.includes('"mode":"videos"'), `panel=${p?.title}`);
});

await test("shop_search respects a price cap", async () => {
  const r = await tool("shop_search", { query: "phone stand", max_price_gbp: 10 });
  assert(r.includes("SHOP FRAMES"), r.slice(0, 120));
  const over = [...r.matchAll(/£([\d,.]+)/g)].map((m) => parseFloat(m[1].replace(",", ""))).filter((n) => n > 10);
  assert(over.length === 0, `prices over cap: ${over.join(",")}`);
});

await test("draft revises in place (writing desk)", async () => {
  await tool("draft", { title: "Smoke draft", content: "version one" });
  await tool("draft", { title: "Smoke draft", content: "version two" });
  const d = await cv("query", "creations:latest", { kind: "doc", titleMatch: "smoke draft" });
  assert(d && d.data === "version two", `data=${d?.data}`);
  await cv("mutation", "creations:remove", { id: d._id });
});

await test("voice election is atomic (CAS)", async () => {
  // The invariant: once a client holds a FRESH voice claim, a DIFFERENT client
  // cannot steal it via electVoice, while the owner keeps its own.
  //
  // Testing this against live prod is only meaningful if we CONTROL the holder:
  // firing electVoice blind depends on whether a real session happens to hold
  // the voice, so it can't distinguish working CAS from a broken always-false
  // election. So we seed a known fresh holder with claimVoice (documented
  // always-wins), assert the invariant deterministically, then restore the
  // prior holder so the test stays side-effect-free outside the smoke thread.
  const before = await cv("query", "ui:getVoice", {});
  try {
    await cv("mutation", "ui:claimVoice", { client: "smoke-owner" });
    const intruder = await cv("mutation", "ui:electVoice", { client: "smoke-intruder" });
    const owner = await cv("mutation", "ui:electVoice", { client: "smoke-owner" });
    assert(intruder === false, `smoke-intruder stole a fresh claim (intruder=${intruder})`);
    assert(owner === true, `smoke-owner lost its own fresh claim (owner=${owner})`);
  } finally {
    // Hand the voice back to whoever held it before us (a real open tab
    // re-claims on interaction anyway; a leftover claim expires in 3 min).
    if (before?.value) await cv("mutation", "ui:claimVoice", { client: before.value });
  }
});

await test("no duplicate answers per question (smoke thread)", async () => {
  const rows = await cv("query", "chatQueue:listMessages", { threadId: THREAD });
  const users = rows.filter((r) => r.role === "user");
  const answers = rows.filter((r) => r.role === "assistant" && r.status === "done" && r.text);
  assert(answers.length <= users.length, `${answers.length} answers for ${users.length} questions`);
});

await test("no tool-garbage rows in the ACTIVE thread's recent history", async () => {
  const active = (await cv("query", "ui:getActiveThread", {})) || "main";
  const rows = await cv("query", "chatQueue:listMessages", { threadId: active });
  const bad = rows
    .slice(-40)
    .filter((r) => r.role === "assistant" && r.status === "done" && r.text && /<function|\{"kind"\s*:/.test(r.text));
  assert(bad.length === 0, `${bad.length} garbage rows, e.g. ${bad[0]?.text?.slice(0, 60)}`);
});

await test("no phantom live lock", async () => {
  const row = await cv("query", "ui:getLiveOn", {});
  if (row && row.value && row.value !== "off") {
    // a real session heartbeats every 20s; older than 2 minutes = leaked lock
    assert(Date.now() - row.updatedAt < 2 * 60_000, `stale live lock from ${row.value} (${Math.round((Date.now() - row.updatedAt) / 1000)}s old)`);
  }
});

await test("metered realtime API route is absent", async () => {
  const r = await fetch(`${BASE}/api/realtime-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}` },
    body: JSON.stringify({ client: "smoke" }),
  });
  assert(r.status === 404, `retired realtime route returned ${r.status}`);
});

await test("timed reminder sets + is due-deliverable", async () => {
  await tool("remind_at", { text: "SMOKE TEST reminder", in_minutes: 0.05 });
  await new Promise((r) => setTimeout(r, 4000));
  const due = await cv("mutation", "reminders:due", {});
  const mine = (due ?? []).filter((d) => d.text.includes("SMOKE TEST"));
  assert(mine.length >= 1, "reminder not due");
  for (const d of mine) await cv("mutation", "reminders:complete", { id: d._id });
});

await test("price watch registers", async () => {
  const r = await tool("price_watch", { query: "SMOKE TEST logitech mx master 3s", target_gbp: 50 });
  assert(/watching|active/i.test(r), r.slice(0, 100));
  const list = await cv("query", "watchRules:list", { status: "active", limit: 80 });
  const mine = (list ?? []).filter((w) => w.label.includes("SMOKE TEST"));
  assert(mine.length >= 1, "watch not created");
  await cv("mutation", "watchRules:cancel", { match: "SMOKE TEST" });
});

await test("a search provider is configured", async () => {
  const r = await fetch(`${BASE}/api/search-status`, { headers: { authorization: `Bearer ${VIEWER_TOKEN}` } });
  const { provider } = await r.json();
  console.log(`      search provider: ${provider}`);
  // serper/serpapi are the keyed web providers; kelkoo/ebay are the keyless
  // floor (DDG web + Kelkoo shopping via Jina) — all count as a live provider.
  assert(["serper", "serpapi", "kelkoo", "ebay"].includes(provider), `no search provider live (${provider})`);
});

await test("read_url returns real content (jina reader)", async () => {
  const r = await tool("read_url", { url: "https://example.com" });
  assert(/example|illustrative|domain/i.test(r), `read_url thin: ${r.slice(0, 80)}`);
});

await test("hide tool clears the panel", async () => {
  await tool("weather", { location: "London" });
  await tool("hide", {});
  const p = await cv("query", "ui:getPanel", {});
  assert(p === null, `panel still up: ${p?.title}`);
});

// ---------------------------------------------------------------------------
// cleanup + report
await fetch(`${BASE}/api/client-state`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${VIEWER_TOKEN}` },
  body: JSON.stringify({ action: "clear_thread", threadId: THREAD }),
}).catch(() => {});
await cv("mutation", "ui:clearPanel", {}).catch(() => {});

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length} passed${skipped ? `, ${skipped} skipped (external limits)` : ""}`);
if (failed.length) {
  const msg = failed.map((f) => `${f.name}: ${f.err}`).join(" | ").slice(0, 900);
  await fetch(`${CV}/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "incidents:report",
      args: {
        source: "smoke-test",
        signature: `smoke:${failed.map((f) => f.name).join(",").slice(0, 60)}`,
        message: msg,
        dispatchToken: DISPATCH_TOKEN,
      },
      format: "json",
    }),
  }).catch(() => {});
  process.exit(1);
}
