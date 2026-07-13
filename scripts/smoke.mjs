#!/usr/bin/env node
// JARVIS nightly smoke test — runs against prod, cleans up after itself, and
// files failures into the Convex `incidents` table so the self-repair healer
// picks them up automatically. Zero dependencies (global fetch only).
//
//   node scripts/smoke.mjs            # full run
//   BASE=... CONVEX=... node scripts/smoke.mjs
//
// Installed as a daily cron on test-vps. Keep tests FAST, IDEMPOTENT and
// side-effect-free outside the "smoke" thread.

const BASE = process.env.BASE ?? "https://jarvis-orcin-six.vercel.app";
const CV = (process.env.CONVEX ?? "https://tangible-goose-318.convex.cloud") + "/api";
const THREAD = "smoke";

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
  const r = await fetch(`${CV}/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(`${path}: ${String(j.errorMessage).slice(0, 160)}`);
  return j.value;
}
async function chat(text) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, threadId: THREAD }),
    signal: AbortSignal.timeout(115_000),
  });
  return await r.json();
}
async function tool(name, args) {
  const r = await fetch(`${BASE}/api/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(115_000),
  });
  return String((await r.json()).result ?? "");
}

// ---------------------------------------------------------------------------
await test("chat answers, clean text", async () => {
  const j = await chat("quick smoke check — reply with one short sentence");
  assert(j.ok === true, `ok=${j.ok} ${j.error ?? ""}`);
  assert(j.text && j.text.length > 2, "empty answer");
  assert(!/<function|\{"kind"\s*:/.test(j.text), `tool garbage in reply: ${j.text.slice(0, 80)}`);
});

await test("weather ask routes to the weather tool + widget panel", async () => {
  const j = await chat("show me the weather");
  assert((j.tools ?? []).includes("weather"), `tools=${j.tools}`);
  const p = await cv("query", "ui:getPanel", {});
  assert(p && p.type === "widget" && p.value.includes('"kind":"weather"'), `panel=${p?.title}`);
});

await test("youtube ask routes to the video lineup", async () => {
  const j = await chat("show me videos of lofi girl");
  assert((j.tools ?? []).includes("youtube_search"), `tools=${j.tools}`);
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

await test("realtime token mints (or is legitimately locked)", async () => {
  const r = await fetch(`${BASE}/api/realtime-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: "smoke" }),
  });
  const j = await r.json();
  if (r.status === 409) return; // someone is genuinely live — fine
  assert(j.token, `no token: ${j.error}`);
  assert(/JARVIS/.test(j.instructions ?? "") && (j.instructions ?? "").length > 2000, "persona instructions missing from token");
  await cv("mutation", "ui:setLiveOn", { client: "smoke", on: false }).catch(() => {});
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
  assert(/watching/i.test(r), r.slice(0, 100));
  const list = await cv("query", "watches:list", {});
  const mine = (list ?? []).filter((w) => w.query.includes("SMOKE TEST"));
  assert(mine.length >= 1, "watch not created");
  await cv("mutation", "watches:cancel", { match: "SMOKE TEST" });
});

await test("a search provider is configured", async () => {
  const r = await fetch(`${BASE}/api/search-status`);
  const { provider } = await r.json();
  console.log(`      search provider: ${provider}`);
  assert(provider === "serper" || provider === "serpapi", `no search provider live (${provider})`);
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
await cv("mutation", "chatQueue:clearThread", { threadId: THREAD }).catch(() => {});
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
      args: { source: "smoke-test", signature: `smoke:${failed.map((f) => f.name).join(",").slice(0, 60)}`, message: msg },
      format: "json",
    }),
  }).catch(() => {});
  process.exit(1);
}
