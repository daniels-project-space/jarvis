import "server-only";
import { NextResponse } from "next/server";
import { streamText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getModel } from "../../../lib/ai";
import { remember, recall } from "../../../lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const convexUrl =
  process.env.CONVEX_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  "https://tangible-goose-318.convex.cloud";

export async function POST(req: Request) {
  let body: { message?: string; thread_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const message = (body?.message ?? "").trim();
  const threadId = body?.thread_id ?? "main";
  if (!message) return NextResponse.json({ ok: false, error: "no_message" }, { status: 400 });

  const convex = new ConvexHttpClient(convexUrl);

  let history: ModelMessage[] = [];
  try {
    const prior = (await convex.query(api.chat.getMessages, { threadId, limit: 12 })) as Array<{
      role: string;
      content: string;
    }>;
    history = prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  } catch {
    // best-effort history
  }

  const model = await getModel();

  const tools = {
    recallMemory: tool({
      description:
        "Search JARVIS long-term memory for relevant notes, facts, preferences, or past decisions. Call this BEFORE answering anything that may depend on stored context.",
      inputSchema: z.object({
        query: z.string().describe("what to look for"),
        limit: z.number().optional(),
      }),
      execute: async ({ query, limit }) => recall({ query, limit }),
    }),
    saveMemory: tool({
      description:
        "Persist a durable fact, preference, decision, or task to long-term memory. Use whenever Daniel states something worth remembering.",
      inputSchema: z.object({
        title: z.string(),
        body: z.string(),
        kind: z.enum(["fact", "preference", "decision", "task", "project", "knowledge"]).optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: async ({ title, body, kind, tags }) => {
        const r = await remember({ title, body, kind, tags });
        return { saved: true, id: r.id };
      },
    }),
  };

  const system = `You are JARVIS, Daniel's dry, impeccably-polite British-butler personal ops assistant.
You maintain a durable long-term memory. Use recallMemory BEFORE answering anything that may depend on prior context, preferences, or stored facts. Use saveMemory whenever Daniel states a durable preference, decision, fact, or task worth remembering.
Be concise — numbers first, prose second, no filler. Never fabricate; if unsure, check memory or say so.
Today's date is ${new Date().toISOString().slice(0, 10)}.`;

  let finalText = "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = streamText({
          model,
          system,
          messages: [...history, { role: "user", content: message }],
          tools,
          maxOutputTokens: 700,
          stopWhen: stepCountIs(6),
          onError: ({ error }) => {
            const m = error instanceof Error ? error.message : String(error);
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: m })}\n\n`));
            } catch {
              /* controller may be closed */
            }
          },
          onFinish: async ({ text }) => {
            finalText = text;
            try {
              await convex.mutation(api.chat.appendTurn, {
                threadId,
                userContent: message,
                assistantContent: finalText,
              });
            } catch {
              // best-effort persistence
            }
          },
        });
        for await (const delta of result.textStream) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, info: "POST { message, thread_id? } to talk to JARVIS." });
}
