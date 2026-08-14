import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";
import {
  codexSessionUnavailableCode,
  isCodexSessionUnavailableCode,
  type CodexSessionUnavailableCode,
} from "../src/lib/codex-session-status";

const REPAIR_HOLD_LIMIT = 8;
const LEGACY_HOLD_LIMIT = 32;

type RuntimeRow = Record<string, unknown>;

function holdCode(row: RuntimeRow): CodexSessionUnavailableCode | null {
  if (row.status !== "needs_input" || row.active === false) return null;
  // New worker holds carry a machine-readable code. Keep the text fallback
  // while already-held production jobs age out; it recognizes the same finite
  // signal and never treats a task or checkpoint as a session status source.
  if (row.controllerSessionRepairRequired === true) {
    return isCodexSessionUnavailableCode(row.controllerSessionHoldCode)
      ? row.controllerSessionHoldCode
      : null;
  }
  return codexSessionUnavailableCode(row.progress);
}

export function controllerSessionStatusFromRows(rows: readonly RuntimeRow[]) {
  for (const row of rows) {
    const code = holdCode(row);
    if (code) return { state: "repair_required" as const, code };
  }
  // This is intentionally not a credential probe: "clear" means that no
  // unresolved durable work has reported a terminal controller-session hold.
  return { state: "clear" as const };
}

/**
 * Owner-visible, bounded session safety state. It reads only durable job
 * projections that a worker has already written after refusing to use an
 * unsafe session; it never acquires, refreshes, or exposes a subscription.
 */
export const status = query({
  args: { ...viewerAuthArgs },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const [typedRows, legacyRows] = await Promise.all([
      ctx.db.query("jobRuntime")
        .withIndex("by_controller_session_repair", (q) => q
          .eq("controllerSessionRepairRequired", true)
          .eq("status", "needs_input"))
        .order("desc")
        .take(REPAIR_HOLD_LIMIT),
      ctx.db.query("jobRuntime")
        .withIndex("by_visibility_status_priority", (q) => q
          .eq("visibility", "conversation")
          .eq("status", "needs_input"))
        .order("desc")
        .take(LEGACY_HOLD_LIMIT),
    ]);
    return controllerSessionStatusFromRows([...typedRows, ...legacyRows]);
  },
});
