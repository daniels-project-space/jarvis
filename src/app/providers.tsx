"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type ReactNode } from "react";
import { resolveConvexUrl } from "@/lib/convex-url";

const convex = new ConvexReactClient(resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL));

export default function Providers({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
