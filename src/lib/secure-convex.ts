"use client";

import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { isGuestViewerSession, useViewerSession } from "./viewer-session";

const GUEST_QUERY_ALLOWLIST = new Set([
  "chatQueue:listMessages",
  "chatQueue:paginatedMessages",
  "chatQueue:listRecentMessages",
  "chatQueue:sessionState",
]);

export function useJarvisQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: "skip" | Omit<FunctionArgs<Query>, "viewerToken">,
): FunctionReturnType<Query> | undefined {
  const viewerToken = useViewerSession();
  const functionName = (query as any)._name as string | undefined;
  const guestBlocked = isGuestViewerSession(viewerToken) && !GUEST_QUERY_ALLOWLIST.has(functionName ?? "");
  const securedArgs = args === "skip" || !viewerToken || guestBlocked
    ? "skip"
    : ({ ...args, viewerToken } as unknown as FunctionArgs<Query>);
  return useQuery(query, securedArgs as FunctionArgs<Query> | "skip");
}
