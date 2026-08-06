import { PROJECT_REGISTRY } from "@/lib/project-registry";

const TRUSTED_EMBED_ORIGINS = new Set(
  PROJECT_REGISTRY.flatMap((project) => {
    if (!project.productionUrl) return [];
    try {
      return [new URL(project.productionUrl).origin];
    } catch {
      return [];
    }
  }),
);

export function isTrustedJarvisEmbedOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  try {
    return TRUSTED_EMBED_ORIGINS.has(new URL(origin).origin) && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

export function resolveTrustedJarvisEmbedOrigin(input: {
  declaredOrigin?: string | null;
  referrer?: string | null;
  ancestorOrigin?: string | null;
}): string | null {
  const candidates = [
    input.declaredOrigin,
    (() => {
      if (!input.referrer) return null;
      try { return new URL(input.referrer).origin; } catch { return null; }
    })(),
    input.ancestorOrigin,
  ];
  return candidates.find(isTrustedJarvisEmbedOrigin) ?? null;
}
