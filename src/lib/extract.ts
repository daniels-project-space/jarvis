import "server-only";
import { convexMutation } from "./context";
import { vaultWrite } from "./obsidian";

// Post-turn memory capture — decoupled from the reply (the sleep-time pattern).
// Used by /api/chat after every text turn and /api/extract after live turns.
// llama-3.3-70b: the 8b model emits malformed JSON too often to trust.

export async function extractMemory(key: string, userText: string, assistantText: string): Promise<number> {
  try {
    const j = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 500,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              "Extract ONLY durable facts, preferences, or decisions worth remembering long-term about Daniel or his projects from this exchange. " +
              'Reply with STRICT JSON: {"items":[{"kind":"fact|preference|decision|project","title":"...","body":"..."}]} — items may be empty. ' +
              'Example: {"items":[{"kind":"preference","title":"Short replies","body":"Daniel wants replies under two sentences."}]}\n\n' +
              `User: ${userText}\nAssistant: ${assistantText}`,
          },
        ],
      }),
    }).then((r) => r.json());
    const content = String(j.choices?.[0]?.message?.content ?? "{}");
    const items = JSON.parse(content)?.items ?? [];
    let n = 0;
    for (const it of (Array.isArray(items) ? items : []).slice(0, 4)) {
      if (!it?.title || !it?.body || !it?.kind) continue;
      await convexMutation("memory:write", {
        kind: String(it.kind),
        title: String(it.title).slice(0, 120),
        body: String(it.body).slice(0, 1200),
        tags: [],
      });
      await vaultWrite(String(it.kind), String(it.title), String(it.body)); // real-time Obsidian
      n++;
    }
    return n;
  } catch {
    return 0; // memory capture is best-effort
  }
}
