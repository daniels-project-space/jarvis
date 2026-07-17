"use client";

import { useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useViewerSession } from "./viewer-session";

export function useJarvisQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: "skip" | Omit<FunctionArgs<Query>, "viewerToken">,
): FunctionReturnType<Query> | undefined {
  const viewerToken = useViewerSession();
  const securedArgs = args === "skip" || !viewerToken
    ? "skip"
    : ({ ...args, viewerToken } as unknown as FunctionArgs<Query>);
  return useQuery(query, securedArgs as FunctionArgs<Query> | "skip");
}
