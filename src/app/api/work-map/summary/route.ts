import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { hubActionsReadiness, listHubTodos } from "@/lib/hub-actions";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };
const MAX_VISIBLE_TODOS = 24;

function response(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * The work map keeps the Hub capability and raw IDs server-side. Its owner-only
 * response exposes only the bounded, display-ready open list needed by the
 * existing To-do panel — never provider errors, authority, or mutation IDs.
 */
export async function GET(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req)) return response({ ok: false }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false }, 403);
  if (!hubActionsReadiness().configured) return response({ ok: false }, 503);

  try {
    const todos = await listHubTodos();
    const open = todos.filter((todo) => todo.done !== true);
    const visibleTodos = open
      .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt)
      .slice(0, MAX_VISIBLE_TODOS)
      .map((todo) => ({
        text: todo.text.slice(0, 240),
        ...(typeof todo.dueDate === "number" && Number.isFinite(todo.dueDate)
          ? { due: new Date(todo.dueDate).toISOString().slice(0, 10) }
          : {}),
        ...(Array.isArray(todo.tags) && todo.tags.length
          ? { tags: todo.tags.filter((tag) => typeof tag === "string").slice(0, 6) }
          : {}),
      }));
    return response({ ok: true, openTodoCount: open.length, todos: visibleTodos });
  } catch {
    // Hub failures may carry provider detail; the map only needs a calm
    // unavailable state and must never echo that detail into the browser.
    return response({ ok: false }, 503);
  }
}
