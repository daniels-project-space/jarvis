import { query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { extractCurrentStateFacts } from "../src/lib/current-state";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

export const getActive = query({
  args: { key: v.string(), ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const row = await ctx.db
      .query("currentState")
      .withIndex("by_key", (q: any) => q.eq("key", args.key))
      .first();
    return row && row.expiresAt > Date.now() ? row : null;
  },
});

export async function captureCurrentState(
  ctx: MutationCtx,
  input: { text: string; messageId: string; observedAt: number },
): Promise<number> {
  const facts = extractCurrentStateFacts(input.text);
  let changed = 0;
  for (const fact of facts) {
    const existing = await ctx.db
      .query("currentState")
      .withIndex("by_key", (q: any) => q.eq("key", fact.key))
      .first();
    if (existing && existing.observedAt > input.observedAt) continue;
    if (existing && existing.value === fact.value && existing.sourceMessageId === input.messageId) continue;
    const row = {
      value: fact.value,
      confidence: fact.confidence,
      sourceMessageId: input.messageId,
      observedAt: input.observedAt,
      expiresAt: input.observedAt + fact.validForMs,
      updatedAt: input.observedAt,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("currentState", { key: fact.key, ...row });
    changed += 1;
  }
  return changed;
}
