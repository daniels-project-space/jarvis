"use client";

import { useQuery } from "convex/react";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { isGuestViewerSession, useViewerSession } from "./viewer-session";

const GUEST_QUERY_ALLOWLIST = new Set([
  "chatQueue:listMessages",
  "chatQueue:paginatedMessages",
  "chatQueue:listRecentMessages",
  "chatQueue:sessionState",
  "chatQueue:turnStatus",
]);

export function isGuestQueryAllowed(query: FunctionReference<"query">): boolean {
  try {
    return GUEST_QUERY_ALLOWLIST.has(getFunctionName(query));
  } catch {
    return false;
  }
}

export function useJarvisQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: "skip" | Omit<FunctionArgs<Query>, "viewerToken">,
): FunctionReturnType<Query> | undefined {
  const viewerToken = useViewerSession();
  const guestBlocked = isGuestViewerSession(viewerToken) && !isGuestQueryAllowed(query);
  const securedArgs = args === "skip" || !viewerToken || guestBlocked
    ? "skip"
    : ({ ...args, viewerToken } as unknown as FunctionArgs<Query>);
  return useQuery(query, securedArgs as FunctionArgs<Query> | "skip");
}
